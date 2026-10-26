//! Best-effort append-only logging of the security-relevant lifecycle events
//! the brief requires: install, uninstall, start, stop, helper launch, desktop
//! changes, and errors. Writes go to the ACL-protected state directory so the
//! log inherits the same protection as the secret. Logging never fails a code
//! path: a log that cannot be written is dropped.

// The writer is compiled out of unit tests (see `event`).
#![cfg_attr(test, allow(dead_code, unused_imports))]

use std::fs::OpenOptions;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::paths;

fn timestamp() -> String {
    // A plain epoch-millisecond stamp keeps the logger dependency-free; the app
    // renders human time. Monotonic ordering within the file is what matters.
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{millis}")
}

/// Append one line tagged with the component that emitted it — only into an
/// existing state directory. The log never creates that directory: `install`
/// creates it with its protected DACL, and one created here would inherit
/// `%ProgramData%`'s user-writable ACEs, which the next install rightly refuses
/// to trust (and an uninstall or rollback must not leave behind). Events before
/// the directory exists, or after it is removed, are dropped.
///
/// Under `cfg(test)` this is a no-op, so unit tests never write to
/// `%ProgramData%` on the machine running them.
#[cfg(test)]
pub fn event(_component: &str, _message: &str) {
    // Keep the log path referenced so the test build has no dead-code warning.
    let _ = paths::log_file;
}

#[cfg(not(test))]
pub fn event(component: &str, message: &str) {
    if !paths::state_dir().is_dir() {
        return;
    }
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths::log_file())
    {
        let _ = writeln!(file, "{}\t{component}\t{message}", timestamp());
    }
}
