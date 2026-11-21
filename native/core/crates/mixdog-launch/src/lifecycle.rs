//! The same files in the same shapes as `process-lifecycle.mjs`, so a later run of either runtime reads what an earlier run of
//! the other left:
//!   - `<data>/diagnostics/process-lifecycle.active/<pid>-<token>.json`, one marker per running process;
//!   - `<data>/diagnostics/process-lifecycle.jsonl`, one JSON line per event, kept to 64 KiB under a file lock
//!     (`process-lifecycle.lock`), the full file moving to `process-lifecycle.jsonl.1`.
//!
//! A run that never finishes leaves its marker behind; the next run that finds it and shows its process gone (no such pid, or
//! the pid now names a process that started at another time) records `prior-process-vanished` for it and removes it.

pub mod host;
pub mod identity;
mod ledger;
mod marker;

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::time::Duration;
use std::time::Instant;

use host::Host;
use host::OsHost;
use ledger::Paths;
use ledger::Wait;
use serde_json::Value;
use serde_json::json;

/// `IDENTITY_UPGRADE_DELAYS_MS`: after the start, then after each attempt that did not settle it.
const IDENTITY_UPGRADE_DELAYS: [Duration; 3] = [Duration::from_millis(1000), Duration::from_millis(9000), Duration::from_millis(20_000)];

/// `VALID_REASONS`.
const VALID_REASONS: [&str; 5] = ["process-start", "prior-process-vanished", "clean-shutdown", "catchable-fatal-error", "forced-cleanup"];

/// How strongly a reason says the run did not end well; the strongest one a run reports is the one its end records.
fn rank(reason: &str) -> Option<i32> {
    match reason {
        "clean-shutdown" => Some(0),
        "catchable-fatal-error" => Some(1),
        "forced-cleanup" => Some(2),
        _ => None,
    }
}

/// `strongerReason`.
fn stronger(current: Option<&str>, candidate: &str) -> String {
    let current_rank = current.map_or(-1, |current| rank(current).unwrap_or(-1));
    if rank(candidate).unwrap_or(0) > current_rank { candidate.to_owned() } else { current.unwrap_or(candidate).to_owned() }
}

/// Where a run keeps its files and what it asks of the machine.
pub struct LifecycleConfig {
    /// The folder of the ledger and the markers; `None` when the data folder cannot be resolved: nothing is then written.
    pub directory: Option<PathBuf>,
    pub host: Arc<dyn Host>,
}

impl LifecycleConfig {
    /// This process: `<data>/diagnostics` (`resolvePluginData()`), on the operating system.
    pub fn process() -> Self {
        Self { directory: crate::crash_capture::paths::data_dir().map(|data| data.join("diagnostics")), host: Arc::new(OsHost) }
    }
}

struct State {
    identity: Option<Value>,
    final_reason: Option<String>,
    final_exit_code: Option<i32>,
    finishing: bool,
    /// The run has finished: it is no longer the active one.
    ended: bool,
}

struct Inner {
    paths: Option<Paths>,
    host: Arc<dyn Host>,
    pid: u32,
    token: String,
    marker_path: Option<PathBuf>,
    cwd: Option<String>,
    state: Mutex<State>,
}

/// How a call to finish went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finished {
    /// The end was written to the ledger and the marker removed.
    pub recorded: bool,
    /// The reason the end carries: the strongest the run reported.
    pub reason: String,
    pub exit_code: Option<i32>,
}

/// One process's run in the ledger, from [`ProcessLifecycle::begin`] to a finish.
#[derive(Clone)]
pub struct ProcessLifecycle {
    inner: Arc<Inner>,
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn is_active(&self) -> bool {
        !self.state().ended
    }

    /// `lifecycleEntry`.
    fn lifecycle_entry(&self, reason: &str, exit_code: Option<i32>) -> Value {
        json!({
            "version": 1,
            "timestamp": host::iso_from_ms(self.host.now_ms()),
            "pid": self.pid,
            "ppid": self.host.parent_pid(),
            "reason": reason,
            "exitCode": exit_code,
            "memory": self.host.memory(),
            "cwd": self.cwd,
        })
    }

    /// `appendEntry`: a synchronous append that never waits for the lock. Whether the line is in the ledger.
    fn append_now(&self, entry: &Value) -> bool {
        let Some(paths) = &self.paths else { return false };
        let line = format!("{}\n", mixdog_js::json_stringify(entry));
        if line.len() as u64 > ledger::MAX_BYTES {
            return false;
        }
        let target = paths.clone();
        ledger::locked(paths, Wait::Never, move || ledger::append_line(&target, &line).unwrap_or(false)).unwrap_or(false)
    }

    /// `recordCurrent`.
    fn record_current(&self, reason: &str, exit_code: Option<i32>) -> bool {
        if !self.is_active() || !VALID_REASONS.contains(&reason) {
            return false;
        }
        self.append_now(&self.lifecycle_entry(reason, exit_code))
    }

    /// `accumulateProcessLifecycleFinish` and the claim of `claimProcessLifecycleFinish`: the reason and the code the end will
    /// carry, when this call is the one that writes it.
    fn claim_finish(&self, reason: &str, exit_code: i32) -> Option<(String, Option<i32>)> {
        let mut state = self.state();
        if state.ended {
            return None;
        }
        accumulate(&mut state, if VALID_REASONS.contains(&reason) { reason } else { "clean-shutdown" }, exit_code);
        if state.finishing {
            return None;
        }
        state.finishing = true;
        Some((state.final_reason.clone().unwrap_or_default(), state.final_exit_code))
    }

    /// `completeProcessLifecycleFinish`: once the end is written the marker goes and the run is over.
    fn complete_finish(&self, written: bool) -> bool {
        if !written {
            self.state().finishing = false;
            return false;
        }
        if self.marker_owned() && self.marker_path.as_deref().is_some_and(|path| std::fs::remove_file(path).is_err()) {
            self.state().finishing = false;
            return false;
        }
        self.state().ended = true;
        true
    }

    /// `scheduleProcessIdentityUpgrade`: while the identity is an estimate from the clock, ask the OS for the real one at 1 s,
    /// then 9 s, then 20 s after the one before.
    fn schedule_identity_upgrade(self: &Arc<Self>, attempt: usize) {
        if !identity::is_estimate(self.state().identity.as_ref()) {
            return;
        }
        let Some(delay) = IDENTITY_UPGRADE_DELAYS.get(attempt).copied() else { return };
        let run = self.clone();
        self.host.schedule(delay, Box::new(move || run.upgrade_identity(attempt)));
    }

    fn upgrade_identity(self: &Arc<Self>, attempt: usize) {
        if !self.is_active() || !self.marker_owned() {
            return;
        }
        let observed = self.host.identity_of(self.pid);
        if !self.is_active() || !self.marker_owned() {
            return;
        }
        if let Some(observed) = observed.filter(|observed| !identity::is_estimate(Some(observed))) {
            let before = self.state().identity.replace(observed);
            if self.write_marker() {
                return;
            }
            self.state().identity = before;
        }
        self.schedule_identity_upgrade(attempt + 1);
    }
}

/// `accumulateProcessLifecycleFinish`'s body, also `recordCatchableFatal`'s: the reason only grows stronger, and the code is the
/// one given with the reason that became the strongest.
fn accumulate(state: &mut State, reason: &str, exit_code: i32) {
    let next = stronger(state.final_reason.as_deref(), reason);
    if state.final_reason.as_deref() != Some(next.as_str()) || state.final_exit_code.is_none() {
        state.final_exit_code = Some(exit_code);
    }
    state.final_reason = Some(next);
}

impl ProcessLifecycle {
    /// `beginProcessLifecycle`: the folders are made, markers left by runs that never finished are found, this run's marker is
    /// written and its start recorded, and the identity upgrade is scheduled. Reporting the unclean ends of the markers found
    /// goes on in the background, after the start is recorded.
    pub fn begin(config: LifecycleConfig) -> Self {
        let LifecycleConfig { directory, host } = config;
        let paths = directory.map(Paths::in_dir);
        if let Some(paths) = &paths {
            let _ = ledger::create_private_dir(&paths.dir);
            let _ = ledger::create_private_dir(&paths.marker_dir);
        }
        let pid = std::process::id();
        let now = host.now_ms();
        let monotonic = host.monotonic_ns();
        let token = format!("{}-{}", host::base36(u128::try_from(now).unwrap_or(0)), host::base36(monotonic));
        // The OS's own answer where it gives one; otherwise an estimate from the clock, which the scheduled attempts replace.
        let identity = host.identity_of(pid).or_else(|| identity::uptime_estimate(now, i64::try_from(monotonic / 1_000_000).unwrap_or(0)));
        let inner = Arc::new(Inner {
            marker_path: paths.as_ref().map(|paths| paths.marker_dir.join(format!("{pid}-{token}.json"))),
            cwd: host.cwd(),
            paths,
            host,
            pid,
            token,
            state: Mutex::new(State { identity, final_reason: None, final_exit_code: None, finishing: false, ended: false }),
        });
        let (vanished, occupied) = inner.scan_markers();
        inner.write_marker();
        inner.record_current("process-start", None);
        inner.schedule_identity_upgrade(0);
        inner.start_reaper(vanished, occupied);
        Self { inner }
    }

    /// The folder of this run's files.
    pub fn directory(&self) -> Option<&Path> {
        self.inner.paths.as_ref().map(|paths| paths.dir.as_path())
    }

    pub fn ledger_path(&self) -> Option<&Path> {
        self.inner.paths.as_ref().map(|paths| paths.ledger.as_path())
    }

    pub fn marker_dir(&self) -> Option<&Path> {
        self.inner.paths.as_ref().map(|paths| paths.marker_dir.as_path())
    }

    pub fn marker_path(&self) -> Option<&Path> {
        self.inner.marker_path.as_deref()
    }

    /// Whether this run has not finished yet.
    pub fn is_active(&self) -> bool {
        self.inner.is_active()
    }

    /// `recordCatchableFatal(exitCode)`: the run caught a fatal error. It is recorded now, and the end of the run will carry it
    /// unless a stronger reason comes.
    pub fn record_catchable_fatal(&self, exit_code: i32) -> bool {
        {
            let mut state = self.inner.state();
            if !state.ended {
                accumulate(&mut state, "catchable-fatal-error", exit_code);
            }
        }
        self.inner.record_current("catchable-fatal-error", Some(exit_code))
    }

    /// `finishProcessLifecycle(reason, exitCode)`: the end is recorded without waiting for the ledger's lock (a try-lock, so it
    /// can be called where nothing may wait: the end of a failing process), the marker is removed, the run is over. A call while
    /// another is finishing, or after the run is over, records nothing.
    pub fn finish(&self, reason: &str, exit_code: i32) -> Finished {
        let Some((final_reason, final_code)) = self.inner.claim_finish(reason, exit_code) else { return self.unclaimed(reason, exit_code) };
        let written = self.inner.append_now(&self.inner.lifecycle_entry(&final_reason, final_code));
        let recorded = self.inner.complete_finish(written);
        Finished { recorded, reason: final_reason, exit_code: final_code }
    }

    /// `finishProcessLifecycleAsync`: [`Self::finish`] where the lock is waited for (up to two seconds) without blocking the
    /// executor. The end is built inside the lock, from the reason the run has by then.
    pub async fn finish_async(&self, reason: &str, exit_code: i32) -> Finished {
        let Some((final_reason, final_code)) = self.inner.claim_finish(reason, exit_code) else { return self.unclaimed(reason, exit_code) };
        let Some(paths) = self.inner.paths.clone() else {
            return Finished { recorded: self.inner.complete_finish(false), reason: final_reason, exit_code: final_code };
        };
        let run = self.inner.clone();
        let target = paths.clone();
        let written = ledger::locked_async(&paths, move || {
            let (reason, code) = {
                let state = run.state();
                if state.ended || !state.finishing {
                    return None;
                }
                (state.final_reason.clone().unwrap_or_default(), state.final_exit_code)
            };
            let line = format!("{}\n", mixdog_js::json_stringify(&run.lifecycle_entry(&reason, code)));
            (line.len() as u64 <= ledger::MAX_BYTES).then(|| ledger::append_line(&target, &line).unwrap_or(false))
        })
        .await
        .flatten()
        .unwrap_or(false);
        let (reason, exit_code) = {
            let state = self.inner.state();
            (state.final_reason.clone().unwrap_or(final_reason), state.final_exit_code.or(final_code))
        };
        Finished { recorded: self.inner.complete_finish(written), reason, exit_code }
    }

    /// What a finish that did not claim the end reports: the run's reason and code as they stand.
    fn unclaimed(&self, reason: &str, exit_code: i32) -> Finished {
        let state = self.inner.state();
        Finished {
            recorded: false,
            reason: state.final_reason.clone().unwrap_or_else(|| reason.to_owned()),
            exit_code: state.final_exit_code.or(Some(exit_code)),
        }
    }
}

/// The run the entry points below keep for the process (Node keeps it on `globalThis`, so every copy of the module shares it).
static CURRENT: Mutex<Option<ProcessLifecycle>> = Mutex::new(None);

/// One process's run, from [`begin_process_lifecycle`] to [`finish_process_lifecycle`].
pub struct LifecycleHandle {
    role: String,
    pid: u32,
    started: Instant,
    lifecycle: ProcessLifecycle,
    fatal: Mutex<Option<String>>,
}

impl LifecycleHandle {
    pub fn role(&self) -> &str {
        &self.role
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// The run in the ledger.
    pub fn lifecycle(&self) -> &ProcessLifecycle {
        &self.lifecycle
    }
}

/// How a run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleEnd {
    /// The reason the end carries: the strongest the run reported.
    pub reason: String,
    pub code: i32,
    /// The text of a fatal error recorded with [`record_catchable_fatal`], if one was.
    pub fatal: Option<String>,
    pub uptime_ms: u128,
    /// The end is in the ledger and the marker is gone.
    pub recorded: bool,
}

/// `beginProcessLifecycle`: this process, in `role` (`tui`, `exec`, ...), starts. A run that is already active is the one
/// returned.
pub fn begin_process_lifecycle(role: &str) -> LifecycleHandle {
    begin_process_lifecycle_with(role, LifecycleConfig::process())
}

/// [`begin_process_lifecycle`] on a given folder and host.
pub fn begin_process_lifecycle_with(role: &str, config: LifecycleConfig) -> LifecycleHandle {
    let mut current = CURRENT.lock().unwrap_or_else(PoisonError::into_inner);
    let active = current.as_ref().filter(|run| run.is_active()).cloned();
    let lifecycle = match active {
        Some(active) => active,
        None => current.insert(ProcessLifecycle::begin(config)).clone(),
    };
    LifecycleHandle { role: role.to_owned(), pid: std::process::id(), started: Instant::now(), lifecycle, fatal: Mutex::new(None) }
}

/// `recordCatchableFatal`: an error the process caught on its way out.
pub fn record_catchable_fatal(handle: &LifecycleHandle, text: &str) {
    *handle.fatal.lock().unwrap_or_else(PoisonError::into_inner) = Some(text.to_owned());
    handle.lifecycle.record_catchable_fatal(1);
}

fn end_of(handle: LifecycleHandle, code: i32, finished: Finished) -> LifecycleEnd {
    let fatal = handle.fatal.into_inner().unwrap_or_else(PoisonError::into_inner);
    LifecycleEnd {
        reason: finished.reason,
        code: finished.exit_code.unwrap_or(code),
        fatal,
        uptime_ms: handle.started.elapsed().as_millis(),
        recorded: finished.recorded,
    }
}

/// `finishProcessLifecycle(reason, exitCode)`: the run ends.
pub fn finish_process_lifecycle(handle: LifecycleHandle, reason: &str, code: i32) -> LifecycleEnd {
    let finished = handle.lifecycle.finish(reason, code);
    end_of(handle, code, finished)
}

/// `finishProcessLifecycleAsync(reason, exitCode)`.
pub async fn finish_process_lifecycle_async(handle: LifecycleHandle, reason: &str, code: i32) -> LifecycleEnd {
    let finished = handle.lifecycle.finish_async(reason, code).await;
    end_of(handle, code, finished)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reason_only_grows_stronger_and_an_unknown_one_ranks_below_everything() {
        assert_eq!(stronger(None, "clean-shutdown"), "clean-shutdown");
        assert_eq!(stronger(Some("clean-shutdown"), "catchable-fatal-error"), "catchable-fatal-error");
        assert_eq!(stronger(Some("forced-cleanup"), "catchable-fatal-error"), "forced-cleanup");
        assert_eq!(stronger(Some("catchable-fatal-error"), "clean-shutdown"), "catchable-fatal-error");
        // `process-start` has no rank: it ranks as -1 as a current reason, and as 0 as a candidate.
        assert_eq!(stronger(Some("process-start"), "clean-shutdown"), "clean-shutdown");
        assert_eq!(stronger(Some("clean-shutdown"), "process-start"), "clean-shutdown");
        assert_eq!(stronger(None, "process-start"), "process-start");
    }

    #[test]
    fn the_code_is_the_one_given_with_the_reason_that_became_the_strongest() {
        let mut state = State { identity: None, final_reason: None, final_exit_code: None, finishing: false, ended: false };
        accumulate(&mut state, "clean-shutdown", 0);
        accumulate(&mut state, "catchable-fatal-error", 7);
        accumulate(&mut state, "clean-shutdown", 3);
        assert_eq!((state.final_reason.as_deref(), state.final_exit_code), (Some("catchable-fatal-error"), Some(7)));
        accumulate(&mut state, "forced-cleanup", 9);
        assert_eq!((state.final_reason.as_deref(), state.final_exit_code), (Some("forced-cleanup"), Some(9)));
    }
}
