//! The Office applications a host left behind when it died before its EOF cleanup could run.
//!
//! A host ended by `TerminateProcess` (or by a crash) never runs its `finally`, and the application it started is not in
//! any job, so a hidden WINWORD, EXCEL or POWERPNT stays with the user's file open. The host keeps a record of its
//! application ([`crate::host::ledger`]); [`sweep`] reads the records of hosts that are gone and ends what the forced
//! cleanup of a live host would have ended (`Close-SessionState`): an application the host owned, in background mode, that
//! is still the process the host recorded (same start time) and shows no window. Anything else, a visible or attached
//! application or a process that is no longer the recorded one, is left alone. The record is then removed.
//!
//! It asks nothing of the user and reports nothing to the model. [`Sweeper`] runs it once when the transport is created
//! and whenever a host leaves without a successful cleanup.

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;

use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use mixdog_rt::TaskClass;
use tokio_util::sync::CancellationToken;

use crate::host::ledger;
use crate::host::ledger::Entry;
use crate::identity::Ownership;
use crate::platform::Platform;

/// How long an application that was ended is waited for, as `Close-SessionState` waits after its kill.
pub const END_WAIT_MS: u32 = 5_000;

/// What one sweep did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// The processes that were ended.
    pub ended: Vec<i32>,
    /// The records that were removed.
    pub removed: usize,
}

/// What became of one process a record names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fate {
    /// Not running any more.
    Gone,
    /// Ended by the sweep.
    Ended,
    /// Left alone: not the recorded process, or showing a window.
    Spared,
    /// Ended and still running after the wait: the record is kept for the next sweep.
    Stuck,
}

/// Whether the host a record names is still running: its pid exists and (when the record knows the start time and the
/// process can be asked for its own) it started then.
fn host_alive(platform: &dyn Platform, pid: u32, start_ticks: i64) -> bool {
    let Ok(pid) = i32::try_from(pid) else { return false };
    if !platform.process_exists(pid) {
        return false;
    }
    if start_ticks <= 0 {
        return true;
    }
    match platform.process_start_ticks(pid) {
        0 => true,
        ticks => ticks == start_ticks,
    }
}

/// The rule of the forced cleanup, for a process a dead host recorded.
fn end_process(platform: &dyn Platform, pid: i32, start_ticks: i64) -> Fate {
    if !platform.process_exists(pid) {
        return Fate::Gone;
    }
    // `[long]$state.AppStartTicks -gt 0 -and the process's start time equals it`.
    if start_ticks <= 0 || platform.process_start_ticks(pid) != start_ticks {
        return Fate::Spared;
    }
    if platform.visible_window_count_for_process(pid) > 0 {
        return Fate::Spared;
    }
    platform.kill_process(pid);
    if platform.wait_for_exit(pid, END_WAIT_MS) { Fate::Ended } else { Fate::Stuck }
}

/// Ends what a dead host's record says may be ended; the processes ended, and whether the record is done with.
fn reap(platform: &dyn Platform, entry: &Entry, ended: &mut Vec<i32>) -> bool {
    let eligible = entry.ownership == Some(Ownership::Owned) && entry.owns_application && entry.mode == ledger::BACKGROUND;
    if !eligible {
        return true;
    }
    let application = (entry.app_pid > 0).then_some((entry.app_pid, entry.app_start_ticks));
    let targets = application.into_iter().chain(entry.chart_excel.iter().map(|tracked| (tracked.pid, tracked.start_ticks)));
    let mut done = true;
    for (pid, start_ticks) in targets {
        match end_process(platform, pid, start_ticks) {
            Fate::Ended => ended.push(pid),
            Fate::Stuck => done = false,
            Fate::Gone | Fate::Spared => {}
        }
    }
    done
}

/// Reads every record under `<data_dir>/office/com-hosts`, ends what the records of dead hosts allow and removes them. A
/// record of a live host is never read for action, and a file that is not a record is left where it is. Runs inside a lane
/// job (`proof`).
pub fn sweep<P: mixdog_fsio::WriteProof>(proof: &P, platform: &dyn Platform, data_dir: &Path) -> Report {
    let mut report = Report::default();
    let Ok(entries) = mixdog_fsio::read_dir(proof, ledger::directory(data_dir)) else { return report };
    for item in entries.flatten() {
        let Some((host_pid, host_ticks)) = item.file_name().to_str().and_then(ledger::parse_file_name) else { continue };
        if host_alive(platform, host_pid, host_ticks) {
            continue;
        }
        let path = item.path();
        let Ok(bytes) = mixdog_fsio::read(proof, &path) else { continue };
        // A record that cannot be read names nothing to end.
        let done = match Entry::parse(&bytes) {
            Some(entry) => reap(platform, &entry, &mut report.ended),
            None => true,
        };
        if done && mixdog_fsio::remove_file(proof, &path).is_ok() {
            report.removed += 1;
        }
    }
    report
}

/// One sweep of this machine, on the real Windows layer; nothing elsewhere.
fn sweep_machine<P: mixdog_fsio::WriteProof>(proof: &P, data_dir: &Path) -> Report {
    #[cfg(windows)]
    if let Ok(platform) = crate::platform::WindowsPlatform::new() {
        return sweep(proof, &platform, data_dir);
    }
    let _ = (proof, data_dir);
    Report::default()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    Running,
    /// A request came in while a sweep ran: one more follows it.
    Again,
}

struct State {
    tokens: LaneTokens,
    data_dir: std::path::PathBuf,
    phase: Mutex<Phase>,
}

impl State {
    fn phase(&self) -> MutexGuard<'_, Phase> {
        self.phase.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Runs [`sweep`] in the background, one at a time: a request made while a sweep is running makes exactly one more follow.
#[derive(Clone)]
pub(crate) struct Sweeper {
    state: Arc<State>,
}

impl Sweeper {
    pub(crate) fn new(tokens: LaneTokens, data_dir: std::path::PathBuf) -> Self {
        Self { state: Arc::new(State { tokens, data_dir, phase: Mutex::new(Phase::Idle) }) }
    }

    /// Asks for a sweep and returns at once.
    pub(crate) fn request(&self) {
        {
            let mut phase = self.state.phase();
            if *phase != Phase::Idle {
                *phase = Phase::Again;
                return;
            }
            *phase = Phase::Running;
        }
        let state = self.state.clone();
        mixdog_rt::spawn("office.sweep", TaskClass::Work, async move {
            loop {
                let data_dir = state.data_dir.clone();
                // A lane that refuses the job or drops it leaves the records for the next sweep.
                if let Ok(job) = state.tokens.maintenance_io.submit(&CancellationToken::new(), move |lane| sweep_machine(lane, &data_dir)) {
                    let _ = job.await;
                }
                let mut phase = state.phase();
                if *phase == Phase::Again {
                    *phase = Phase::Running;
                } else {
                    *phase = Phase::Idle;
                    return;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::ledger::Tracked;
    use crate::platform::FakePlatform;
    use crate::platform::FakeWindow;

    fn owned_background(app_pid: i32, app_start_ticks: i64) -> Entry {
        Entry {
            format: "docx".into(),
            mode: ledger::BACKGROUND.into(),
            ownership: Some(Ownership::Owned),
            owns_application: true,
            app_pid,
            app_start_ticks,
            chart_excel: Vec::new(),
        }
    }

    #[test]
    fn an_ended_process_is_listed_and_a_visible_application_is_spared() {
        let platform = FakePlatform::new();
        platform.add_process(10, "WINWORD", 500);
        let mut ended = Vec::new();
        assert!(reap(&platform, &owned_background(10, 500), &mut ended));
        assert_eq!(ended, [10]);
        platform.add_window(FakeWindow::new(1, 20, "OpusApp", "x"));
        platform.add_process(20, "WINWORD", 600);
        assert!(reap(&platform, &owned_background(20, 600), &mut ended), "a visible application is spared, and the record is done");
        assert_eq!(ended, [10]);
    }

    #[test]
    fn the_chart_excel_of_an_owned_background_presentation_follows_the_application() {
        let platform = FakePlatform::new();
        platform.add_process(10, "POWERPNT", 500);
        platform.add_process(11, "EXCEL", 510);
        platform.add_process(12, "EXCEL", 520);
        let mut entry = owned_background(10, 500);
        entry.format = "pptx".into();
        entry.chart_excel = vec![Tracked { pid: 11, start_ticks: 510 }, Tracked { pid: 12, start_ticks: 999 }];
        let mut ended = Vec::new();
        assert!(reap(&platform, &entry, &mut ended));
        assert_eq!(ended, [10, 11], "pid 12 started at another time than recorded: not the recorded process");
        assert!(platform.process_exists(12));
    }

    #[test]
    fn a_record_that_is_not_an_owned_background_application_names_nothing_to_end() {
        let platform = FakePlatform::new();
        platform.add_process(10, "WINWORD", 500);
        for tweak in [
            |entry: &mut Entry| entry.mode = "visible".into(),
            |entry: &mut Entry| entry.mode = "attach".into(),
            |entry: &mut Entry| entry.ownership = Some(Ownership::Attached),
            |entry: &mut Entry| entry.ownership = None,
            |entry: &mut Entry| entry.owns_application = false,
            |entry: &mut Entry| entry.app_start_ticks = 0,
            |entry: &mut Entry| entry.app_start_ticks = 501,
        ] {
            let mut entry = owned_background(10, 500);
            tweak(&mut entry);
            let mut ended = Vec::new();
            assert!(reap(&platform, &entry, &mut ended));
            assert!(ended.is_empty());
            assert!(platform.process_exists(10));
        }
    }

    #[test]
    fn a_host_whose_pid_is_taken_by_another_process_is_gone_and_one_that_cannot_be_asked_is_alive() {
        let platform = FakePlatform::new();
        platform.add_process(5, "mixdogd", 100);
        assert!(host_alive(&platform, 5, 100));
        assert!(!host_alive(&platform, 5, 101), "same pid, another start time: the host died and the pid was reused");
        assert!(host_alive(&platform, 5, 0), "a record that could not read its host's start time tells it by pid only");
        assert!(!host_alive(&platform, 6, 100));
    }
}
