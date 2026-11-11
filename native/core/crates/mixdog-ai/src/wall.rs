//! The wall clock a provider stamps its session state with (`Date.now()`).
//!
//! A development-only seam, inert unless a test sets it: [`set`] fixes the time a recording's frozen `Date.now`
//! returned, so a replay stamps what Node stamped. Without it the time is the system's.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg_attr(not(any(test, feature = "test-support")), allow(dead_code))]
static FIXED: AtomicU64 = AtomicU64::new(0);

/// Unix milliseconds: the fixed time when a test set one, else the system's.
pub(crate) fn now_ms() -> u64 {
    #[cfg(any(test, feature = "test-support"))]
    if let fixed @ 1.. = FIXED.load(Ordering::Relaxed) {
        return fixed;
    }
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Fixes the wall clock at `ms`; `None` puts back the system's.
#[cfg(any(test, feature = "test-support"))]
pub fn set(ms: Option<u64>) {
    FIXED.store(ms.unwrap_or(0), Ordering::Relaxed);
}
