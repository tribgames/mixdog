//! What the config has read from its file and rebuilt, counted so a test can show that a reader of non-credential settings does
//! neither (`decisions.md` "Node daemon hot paths found by profiling" 6). Counted at the points every route passes: the read of
//! the config file itself (whichever instance, open or reload) and the rebuild of the agent section. Compiled only with the
//! test-only feature `count-work`, which a dev-dependency turns on; a test takes the difference around the read it watches.

use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

static FILE_READS: AtomicU64 = AtomicU64::new(0);
static AGENT_REBUILDS: AtomicU64 = AtomicU64::new(0);

pub(crate) fn file_read() {
    FILE_READS.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn agent_rebuilt() {
    AGENT_REBUILDS.fetch_add(1, Ordering::Relaxed);
}

/// Reads of a config file by any `Config` since the process started (the opening read, a reload, a secret-change read).
pub fn file_reads() -> u64 {
    FILE_READS.load(Ordering::Relaxed)
}

/// `Config::loaded_agent` runs since the process started.
pub fn agent_rebuilds() -> u64 {
    AGENT_REBUILDS.load(Ordering::Relaxed)
}