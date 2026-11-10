//! What the secret stores have read, counted at the places that perform the read: the DPAPI file (Windows), the keychain item
//! (macOS), the Secret Service lookup (Linux), the private secrets file behind it, and the in-process store. A wrapper over a
//! store (`TrackedStore`, `FallbackStore`) delegates and does not count, so one lookup is counted once however many layers it
//! passes. Compiled only with the test-only feature `count-work`, which a dev-dependency turns on; a test takes the difference
//! around the read it watches.

use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

static SECRET_READS: AtomicU64 = AtomicU64::new(0);

pub(crate) fn secret_read() {
    SECRET_READS.fetch_add(1, Ordering::Relaxed);
}

/// Reads performed by the stores of this crate since the process started.
pub fn secret_reads() -> u64 {
    SECRET_READS.load(Ordering::Relaxed)
}
