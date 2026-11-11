//! Test seam (`elide-syncs`): the physical flushes of a process, skipped.
//!
//! A test reads back what it wrote from the same running OS, which holds every write whether or not it was flushed to
//! the device; what a flush adds is survival of a power loss, which no test observes. The flushes were what the
//! write-heavy tests waited on (2026-11-11, beside twenty other builds: the migration crash matrix took 187 s with
//! them and 44 s without), and they starve the builds that share the disk.
//!
//! Off until a test switches it on: [`elide_syncs`] in the test, or `MIXDOG_TEST_ELIDE_SYNCS=1` in the environment of
//! the test process (cargo-gate sets it for a test run; the processes a test starts inherit it). Only the flush call
//! is skipped: the handle is opened as ever, so a missing directory or a refused open fails as in production. A test
//! of the flush itself (a directory handle `FlushFileBuffers` accepts) calls [`real_syncs`] first.

#[cfg(feature = "elide-syncs")]
mod switch {
    use std::sync::OnceLock;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    static ASKED: AtomicBool = AtomicBool::new(false);
    static REAL: AtomicBool = AtomicBool::new(false);
    static FROM_ENV: OnceLock<bool> = OnceLock::new();

    /// Skips the physical flushes of this process from now on.
    pub fn elide_syncs() {
        ASKED.store(true, Ordering::Relaxed);
    }

    /// Keeps the physical flushes of this process, whatever asked for them to be skipped.
    pub fn real_syncs() {
        REAL.store(true, Ordering::Relaxed);
    }

    /// Whether a flush is skipped now.
    pub fn syncs_elided() -> bool {
        if REAL.load(Ordering::Relaxed) {
            return false;
        }
        ASKED.load(Ordering::Relaxed)
            || *FROM_ENV.get_or_init(|| std::env::var_os("MIXDOG_TEST_ELIDE_SYNCS").is_some_and(|v| v == "1"))
    }
}

#[cfg(feature = "elide-syncs")]
pub use switch::elide_syncs;
#[cfg(feature = "elide-syncs")]
pub use switch::real_syncs;
#[cfg(feature = "elide-syncs")]
pub use switch::syncs_elided;

/// A production build has no switch: every flush is done.
#[cfg(not(feature = "elide-syncs"))]
pub const fn syncs_elided() -> bool {
    false
}

/// [`std::fs::File::sync_all`] on a `std` handle, for the callers that hold one.
pub fn sync_all(file: &std::fs::File) -> std::io::Result<()> {
    if syncs_elided() { Ok(()) } else { file.sync_all() }
}

/// [`std::fs::File::sync_data`] on a `std` handle, for the callers that hold one.
pub fn sync_data(file: &std::fs::File) -> std::io::Result<()> {
    if syncs_elided() { Ok(()) } else { file.sync_data() }
}

/// SQLite's `synchronous` setting of a durable database: `FULL`, and `OFF` while flushes are skipped (its own
/// `FlushFileBuffers` at every commit is the same wait).
pub fn sqlite_synchronous() -> &'static str {
    if syncs_elided() { "OFF" } else { "FULL" }
}
