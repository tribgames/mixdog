//! The process lifecycle a launching binary reports around its own run: begin, a fatal error it could still catch, finish with a
//! reason and an exit code. The entry points are fixed here so the binary can call them; the ledger they write to (the active
//! markers and `process-lifecycle.jsonl` of `process-lifecycle.mjs`) is filled in by the ledger task, and until then they only
//! carry the facts to the caller.

use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Instant;

/// One process's run, from [`begin_process_lifecycle`] to [`finish_process_lifecycle`].
pub struct LifecycleHandle {
    role: String,
    pid: u32,
    started: Instant,
    fatal: Mutex<Option<String>>,
}

impl LifecycleHandle {
    pub fn role(&self) -> &str {
        &self.role
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }
}

/// How a run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleEnd {
    pub reason: String,
    pub code: i32,
    /// The text of a fatal error recorded with [`record_catchable_fatal`], if one was.
    pub fatal: Option<String>,
    pub uptime_ms: u128,
}

/// `beginProcessLifecycle`: this process, in `role` (`tui`, `exec`, ...), starts.
pub fn begin_process_lifecycle(role: &str) -> LifecycleHandle {
    LifecycleHandle { role: role.to_owned(), pid: std::process::id(), started: Instant::now(), fatal: Mutex::new(None) }
}

/// `recordCatchableFatal`: an error the process caught on its way out.
pub fn record_catchable_fatal(handle: &LifecycleHandle, text: &str) {
    *handle.fatal.lock().unwrap_or_else(PoisonError::into_inner) = Some(text.to_owned());
}

/// `finishProcessLifecycle(reason, exitCode)`: the run ends.
pub fn finish_process_lifecycle(handle: LifecycleHandle, reason: &str, code: i32) -> LifecycleEnd {
    let fatal = handle.fatal.into_inner().unwrap_or_else(PoisonError::into_inner);
    LifecycleEnd { reason: reason.to_owned(), code, fatal, uptime_ms: handle.started.elapsed().as_millis() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_reports_its_reason_code_and_the_fatal_it_caught() {
        let handle = begin_process_lifecycle("tui");
        assert_eq!((handle.role(), handle.pid()), ("tui", std::process::id()));
        record_catchable_fatal(&handle, "boom");
        let end = finish_process_lifecycle(handle, "fatal", 1);
        assert_eq!((end.reason.as_str(), end.code, end.fatal.as_deref()), ("fatal", 1, Some("boom")));
    }
}
