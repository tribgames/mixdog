//! A check the matcher reads while it backtracks (not in fancy-regex upstream; added for mixdog).
//!
//! A caller that runs matches under a large `backtrack_limit` sets a check on its thread with [`checking`]; every
//! [`INTERVAL`] backtracking steps of a match on that thread the matcher calls it, and when it answers `true` the match
//! ends as if it had reached its limit (`RuntimeError::BacktrackLimitExceeded`). The caller tells the two apart by its
//! own check. Without a check, matching is unchanged.

use alloc::rc::Rc;
use core::cell::RefCell;

/// The backtracking steps between two reads of the check.
pub const INTERVAL: usize = 1 << 16;

std::thread_local! {
    static CHECK: RefCell<Option<Rc<dyn Fn() -> bool>>> = const { RefCell::new(None) };
}

/// Runs `run` with `check` read by every match on this thread, then restores the check that was set before (also when
/// `run` unwinds).
pub fn checking<R>(check: Rc<dyn Fn() -> bool>, run: impl FnOnce() -> R) -> R {
    struct Restore(Option<Rc<dyn Fn() -> bool>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let before = self.0.take();
            CHECK.with(|slot| *slot.borrow_mut() = before);
        }
    }
    let _restore = Restore(CHECK.with(|slot| slot.borrow_mut().replace(check)));
    run()
}

/// Whether the check set on this thread asks the match to end.
pub(crate) fn interrupted() -> bool {
    let check = CHECK.with(|slot| slot.borrow().clone());
    check.is_some_and(|check| check())
}
