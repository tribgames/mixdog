//! A stop the matcher reads while it runs (not in fancy-regex upstream; added for mixdog, see `MIXDOG.md` beside this
//! crate).
//!
//! A caller that runs matches under a large `backtrack_limit` sets a stop on its thread with [`checking`]. A match on
//! that thread (and `is_match` of a pattern regex-automata runs whole) counts its work in steps and reads the stop, one
//! relaxed atomic load, each time its steps pass a multiple of [`INTERVAL`], and before and after every search it hands
//! to regex-automata; once the stop reads `true` the match ends as if it had reached its limit
//! (`RuntimeError::BacktrackLimitExceeded`). The caller tells the two apart by its own stop. Without a stop the steps
//! are counted and never read.
//!
//! A step is one instruction of the VM or one backtrack, weighted by the bytes it examines where that is more than one.
//! A search handed to regex-automata runs its lazy DFA here, one byte at a time, and counts [`CHUNK`] steps per
//! `CHUNK` bytes; so do a long back-reference, a look-behind's step back and `\Z`. No step weighs more than `CHUNK`,
//! except a literal of the pattern, which compares its own bytes. Between two reads of the stop a match therefore takes
//! fewer than `INTERVAL + CHUNK` steps (`INTERVAL + max(CHUNK, the pattern's longest literal)`).
//!
//! Exceptions, each one call into regex-automata over bytes the stepped DFA has just read: the groups of a delegated
//! match (or of a variable-length look-behind) holding capturing groups are read by the meta engine over that match
//! only; and a sub-pattern holding a Unicode word boundary, which the lazy DFA cannot search past a non-ASCII byte, or
//! one regex-automata builds no lazy DFA for (one whose automaton outgrows the DFA's cache), is searched by the meta
//! engine whole. The UTF-8 check of a case-insensitive back-reference is one step of its length.

#[cfg(feature = "std")]
pub use self::thread::checking;
#[cfg(feature = "std")]
pub(crate) use self::thread::Steps;

/// The steps between two reads of the stop.
pub const INTERVAL: u64 = 1 << 16;
/// The bytes (or characters) a stepped search, a back-reference, a look-behind's step back or `\Z` reads per step of
/// that weight.
pub const CHUNK: usize = 1 << 10;

/// Without `std` there is no thread to set a stop on: the steps are not counted.
#[cfg(not(feature = "std"))]
pub(crate) struct Steps;

#[cfg(not(feature = "std"))]
impl Steps {
    pub(crate) fn new() -> Self {
        Self
    }

    #[inline(always)]
    pub(crate) fn take(&mut self, _weight: u64) -> bool {
        true
    }

    #[inline(always)]
    pub(crate) fn read_now(&mut self) -> bool {
        true
    }
}

#[cfg(feature = "std")]
mod thread {
    use alloc::sync::Arc;
    use core::cell::RefCell;
    use core::sync::atomic::AtomicBool;
    use core::sync::atomic::Ordering;

    use super::INTERVAL;

    std::thread_local! {
        static STOP: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
    }

    /// Runs `run` with `stop` read by every match on this thread, then restores the stop that was set before (also when
    /// `run` unwinds).
    pub fn checking<R>(stop: Arc<AtomicBool>, run: impl FnOnce() -> R) -> R {
        struct Restore(Option<Arc<AtomicBool>>);
        impl Drop for Restore {
            fn drop(&mut self) {
                let before = self.0.take();
                STOP.with(|slot| *slot.borrow_mut() = before);
            }
        }
        let _restore = Restore(STOP.with(|slot| slot.borrow_mut().replace(stop)));
        run()
    }

    /// The stop set on this thread, read once when a match starts.
    pub(crate) fn current() -> Option<Arc<AtomicBool>> {
        STOP.with(|slot| slot.borrow().clone())
    }

    /// The steps of one match and the stop it reads.
    pub(crate) struct Steps {
        stop: Option<Arc<AtomicBool>>,
        taken: u64,
        next_read: u64,
    }

    impl Steps {
        pub(crate) fn new() -> Self {
            let stop = current();
            let next_read = if stop.is_some() { INTERVAL } else { u64::MAX };
            Self { stop, taken: 0, next_read }
        }

        /// Counts `weight` steps, and reads the stop when they pass a multiple of [`INTERVAL`]: `false` once it is set.
        #[inline(always)]
        pub(crate) fn take(&mut self, weight: u64) -> bool {
            self.taken += weight;
            self.taken < self.next_read || self.read()
        }

        /// Reads the stop now (before a delegated search): `false` once it is set.
        #[inline(always)]
        pub(crate) fn read_now(&mut self) -> bool {
            self.stop.is_none() || self.read()
        }

        #[cold]
        #[inline(never)]
        fn read(&mut self) -> bool {
            self.next_read = (self.taken / INTERVAL + 1) * INTERVAL;
            #[cfg(feature = "probe")]
            super::probe::record(self.taken);
            !self.stop.as_ref().is_some_and(|stop| stop.load(Ordering::Relaxed))
        }
    }
}

/// The steps at which the matches of this thread read the stop (feature `probe`, for tests).
#[cfg(all(feature = "std", feature = "probe"))]
pub mod probe {
    use alloc::vec::Vec;
    use core::cell::RefCell;

    std::thread_local! {
        static READS: RefCell<Option<Vec<u64>>> = const { RefCell::new(None) };
    }

    pub(crate) fn record(taken: u64) {
        READS.with(|reads| {
            if let Some(reads) = reads.borrow_mut().as_mut() {
                reads.push(taken);
            }
        });
    }

    /// The step counts at each read on this thread since the last call (none before the first), in order (a new match
    /// starts again from 0); records from now on.
    pub fn take_reads() -> Vec<u64> {
        READS.with(|reads| reads.borrow_mut().replace(Vec::new()).unwrap_or_default())
    }
}
