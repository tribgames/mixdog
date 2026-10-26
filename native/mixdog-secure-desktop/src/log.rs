//! Best-effort append-only logging of the security-relevant lifecycle events
//! the brief requires: install, uninstall, start, stop, helper launch, desktop
//! changes, and errors. Writes go to the ACL-protected state directory so the
//! log inherits the same protection as the secret. Logging never fails a code
//! path: a log that cannot be written is dropped.

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

/// Append one line tagged with the component that emitted it.
pub fn event(component: &str, message: &str) {
    let dir = paths::state_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths::log_file())
    {
        let _ = writeln!(file, "{}\t{component}\t{message}", timestamp());
    }
}
