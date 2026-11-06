//! The session layer's memoized answers that a setting change drops.

use mixdog_core::run_host::live_gauge::LiveGauge;

/// `invalidateContextStatusCache()`: drop the context gauge's memo for every session the process
/// holds. Node memoizes the last status (`context-status-cache.mjs`); the gauge behind
/// `thread/contextStatus` measures the live session on every read and keeps no memo, so
/// `LiveGauge` is the one implementation and has nothing to drop.
pub trait ContextStatusCaches: Send + Sync {
    fn invalidate_all(&self);
}

impl ContextStatusCaches for LiveGauge {
    fn invalidate_all(&self) {}
}
