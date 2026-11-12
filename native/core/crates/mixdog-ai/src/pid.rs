//! The process id a provider keys per-process state with (`process.pid`: xAI's ephemeral cache routing).
//!
//! A development-only seam, compiled only under `cfg(test)` or the `test-support` feature (which `build.rs` refuses in a
//! release-profile build) and inert unless a test sets it: [`set`] fixes the pid a recording's world fixed, so a replay
//! keys what Node keyed. The pid belongs to the replay's scope (`random::run_scoped`), as the wall clock does.

#[cfg(any(test, feature = "test-support"))]
static PID: crate::random::scripted::Script<u32> = crate::random::scripted::Script::new();

/// This scope's scripted pid when its test set one, else the process's.
pub(crate) fn id() -> u32 {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(pid) = PID.peek() {
        return pid;
    }
    std::process::id()
}

/// Fixes this scope's pid at `pid`; `None` puts back the process's.
#[cfg(any(test, feature = "test-support"))]
pub fn set(pid: Option<u32>) {
    PID.set(pid.map(|pid| [pid].into()));
}

/// Removes scope `id`'s pid (the scope ended).
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn clear(id: u64) {
    PID.clear(id);
}
