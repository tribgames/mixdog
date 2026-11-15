//! The millisecond clock the application reads. The run loop sets it from the monotonic clock once per turn; a test sets it by
//! hand, so every time-dependent transition (the Enter latch, the hint dismissal, the exit flow) is deterministic.

use std::cell::Cell;
use std::rc::Rc;

/// A shared millisecond counter (`Date.now()` of the Node application).
#[derive(Clone, Debug, Default)]
pub struct Clock(Rc<Cell<u64>>);

impl Clock {
    pub fn new(now_ms: u64) -> Self {
        Self(Rc::new(Cell::new(now_ms)))
    }

    pub fn now(&self) -> u64 {
        self.0.get()
    }

    pub fn set(&self, now_ms: u64) {
        self.0.set(now_ms);
    }

    pub fn advance(&self, by_ms: u64) {
        self.0.set(self.0.get() + by_ms);
    }
}
