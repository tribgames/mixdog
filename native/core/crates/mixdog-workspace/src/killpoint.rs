//! Crash-injection points for the recovery journal's kill-point matrix (DS-WS-3). Compiled
//! only with the `kill-points` feature (enabled for this crate's own tests): the process is
//! aborted without any cleanup when the environment names the point.

#[cfg(feature = "kill-points")]
pub fn hit(name: &str) {
    if std::env::var("MIXDOG_KILL_AT").as_deref() == Ok(name) {
        std::process::abort();
    }
}

#[cfg(not(feature = "kill-points"))]
#[inline(always)]
pub fn hit(_name: &str) {}
