//! Debug builds only: the two seams a replay of Node's recordings needs over a built daemon, and the log of the programs the crate
//! tried to start. A release build has neither: every function here is then a constant.
//!
//! The replay names a control file in `MIXDOG_SCM_DEBUG_SEAM` and rewrites it between calls, the way a test advances a clock:
//! `{"runLimitMs": n, "runLimitFor": word, "clockSkewMs": n}` replaces the run limit of every child that has one and was given `word` as an argument, and moves the clock of the
//! remote-list cache (Node's recording does the same with a shortened deadline and a skewed `Date.now`). The attempt log is the file
//! named in `MIXDOG_SCM_DEBUG_ATTEMPTS`: one JSON line per attempt to start a program, in the order the attempts finished, whether
//! the program started or not.

use std::time::Duration;
use std::time::Instant;

#[cfg(debug_assertions)]
fn control() -> Option<serde_json::Value> {
    let path = std::env::var_os("MIXDOG_SCM_DEBUG_SEAM")?;
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// The run limit a child with one is given instead of its own.
pub(crate) fn run_limit(own: Option<Duration>, args: &[String]) -> Option<Duration> {
    #[cfg(debug_assertions)]
    if own.is_some()
        && let Some(seam) = control()
        && let Some(ms) = seam["runLimitMs"].as_u64()
        && seam["runLimitFor"].as_str().is_some_and(|word| args.iter().any(|arg| arg == word))
    {
        return Some(Duration::from_millis(ms));
    }
    #[cfg(not(debug_assertions))]
    let _ = args;
    own
}

/// The moment the remote-list cache reads, moved by the control file's skew (forwards or backwards, as `Date.now` is).
pub(crate) fn cache_clock() -> Instant {
    let now = Instant::now();
    #[cfg(debug_assertions)]
    if let Some(ms) = control().and_then(|seam| seam["clockSkewMs"].as_i64()) {
        let skew = Duration::from_millis(ms.unsigned_abs());
        return if ms >= 0 { now + skew } else { now - skew };
    }
    now
}

/// One attempt to start `program` with `args` (`pty` for the sign-in's terminal child), and whether it started.
pub(crate) fn attempt(program: &str, args: &[String], pty: bool, started: bool) {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("MIXDOG_SCM_DEBUG_ATTEMPTS") {
        use std::io::Write;
        let line = serde_json::json!({ "program": program, "args": args, "pty": pty, "started": started });
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{line}");
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = (program, args, pty, started);
}