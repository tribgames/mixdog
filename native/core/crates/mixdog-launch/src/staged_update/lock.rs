//! The exclusive `<pid> <ms>` lock file (`claimPidLockFile`): `.staging.lock` of one version and `.swap.lock` of the staging area.

use std::io::Write;
use std::path::Path;
use std::time::Duration;
use std::time::SystemTime;

use super::Context;
use super::layout::parse_int_prefix;

/// `STALE_INPROGRESS_MS`: a lock this old is taken over even when its owner lives.
const STALE: Duration = Duration::from_secs(10 * 60);

fn write_new(lock: &Path) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(lock)?;
    write!(file, "{} {}", std::process::id(), super::now_ms())
}

/// The pid a lock names: its first word, 0 when it is not a number.
fn owner_of(lock: &Path) -> u32 {
    let text = std::fs::read_to_string(lock).unwrap_or_default();
    parse_int_prefix(text.split_whitespace().next().unwrap_or(""))
}

/// Whether the owner `pid` runs (a pid that is not positive never does).
fn owner_runs(context: &Context, pid: u32) -> bool {
    pid != 0 && (context.process_runs)(pid)
}

/// Claims `lock`: true when this process now holds it. An existing lock is taken over only when stale (its owner is gone or it is
/// over ten minutes old).
pub(super) fn claim(context: &Context, lock: &Path) -> bool {
    match write_new(lock) {
        Ok(()) => return true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return false,
    }
    let age = std::fs::metadata(lock).and_then(|meta| meta.modified()).ok().map(|modified| SystemTime::now().duration_since(modified).unwrap_or_default());
    if owner_runs(context, owner_of(lock)) && age.is_some_and(|age| age < STALE) {
        return false;
    }
    drop(std::fs::remove_file(lock));
    write_new(lock).is_ok()
}

/// `waitForSwapLockClear`: until the lock is gone (its owner finished) or `timeout` passes. A lock of an owner that is gone is
/// removed and counts as cleared. False when a live owner still held it at the deadline.
pub(super) fn wait_clear(context: &Context, lock: &Path, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if !lock.exists() {
            return true;
        }
        if !owner_runs(context, owner_of(lock)) {
            drop(std::fs::remove_file(lock));
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    !lock.exists()
}
