//! The integration tests of `mixdog-launch`, one binary: the launcher's crash capture, its process lifecycle ledger and, with the
//! `fake-core` feature, `ensure_core` against a test core.

mod crash_capture;
#[cfg(feature = "fake-core")]
mod ensure_core;
mod lifecycle;
