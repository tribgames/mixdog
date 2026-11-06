//! The gauge behind `thread/contextStatus`, as the target of `invalidateContextStatusCache`.
//!
//! Node's `createContextStatusCache` (`context-status-cache.mjs`) is a one-slot memo of the last
//! status, keyed on the inputs it was computed from; `invalidate` clears the slot because the
//! catalog, route and config can change without moving any key field. The Rust gauge
//! (`LiveContextWorld` + `context_status`) keeps no memo: every read measures the live session, so
//! it can never answer from a stale slot and there is nothing to drop. `LiveGauge` is that fact
//! as one value: the single target both invalidation seams (`ContextStatusCache`, per thread, and
//! the daemon's `ContextStatusCaches`, all threads) are wired to.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::route_session::ContextStatusCache;

#[derive(Debug, Default)]
pub struct LiveGauge;

impl LiveGauge {
    pub fn new() -> Arc<Self> {
        Arc::new(Self)
    }
}

impl ContextStatusCache for LiveGauge {
    fn invalidate(&self, _thread: &ThreadId) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_the_per_thread_seam() {
        let gauge: Arc<dyn ContextStatusCache> = LiveGauge::new();
        gauge.invalidate(&ThreadId::from("s_a"));
    }
}
