//! The active markers: one file per running process in `process-lifecycle.active/`, written at start and removed at the end.
//! A marker that is still there when a later run looks belongs to a process that never finished; once that process is shown
//! to be gone, the later run records its unclean end in the ledger and removes the marker.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mixdog_store::fsio::Access;
use serde_json::Value;
use serde_json::json;

use super::Inner;
use super::identity;
use super::ledger;
use super::ledger::Wait;

/// A marker as a scan read it, with the file it was in.
pub(super) struct Marker {
    path: PathBuf,
    previous: Value,
}

/// The largest pid `process.kill` accepts.
const MAX_PID: f64 = 2_147_483_647.0;

/// `Number.isInteger(pid)` within the pids a process can have.
fn pid_of(value: Option<&Value>) -> Option<u32> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && (1.0..=MAX_PID).contains(&number)).then_some(number as u32)
}

fn read_marker(path: &Path) -> Option<Value> {
    mixdog_js::json_parse(&std::fs::read_to_string(path).ok()?).ok()
}

/// What `renameWithRetrySync` retries on: the answers of a file held for a moment by another program.
fn retryable(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error().is_some_and(|code| code == libc::EPERM || code == libc::EACCES || code == libc::EBUSY || code == libc::EEXIST)
    }
    #[cfg(windows)]
    {
        // ACCESS_DENIED, SHARING_VIOLATION, LOCK_VIOLATION, FILE_EXISTS, ALREADY_EXISTS.
        error.raw_os_error().is_some_and(|code| matches!(code, 5 | 32 | 33 | 80 | 183))
    }
}

/// `DEFAULT_BACKOFFS_MS`: 25, 50, 100, then twenty waits of 200 ms.
fn backoffs() -> impl Iterator<Item = Duration> {
    [25, 50, 100].into_iter().chain(std::iter::repeat_n(200, 20)).map(Duration::from_millis)
}

impl Inner {
    /// `writeMarker`: the marker is published whole (written, flushed, renamed over any earlier one), owner-only.
    pub(super) fn write_marker(&self) -> bool {
        let (Some(paths), Some(path)) = (&self.paths, &self.marker_path) else { return false };
        if ledger::create_private_dir(&paths.marker_dir).is_err() {
            return false;
        }
        let identity = self.state().identity.clone();
        let marker = json!({
            "version": 1,
            "timestamp": super::host::iso_from_ms(self.host.now_ms()),
            "pid": self.pid,
            "ppid": self.host.parent_pid(),
            "token": self.token,
            "processIdentity": identity,
        });
        let bytes = format!("{}\n", mixdog_js::json_stringify(&marker));
        let mut waits = backoffs();
        loop {
            match mixdog_store::fsio::publish_file_with(path, bytes.as_bytes(), Access::OwnerOnly) {
                Ok(()) => return true,
                Err(error) if retryable(&error.source) => match waits.next() {
                    Some(wait) => std::thread::sleep(wait),
                    None => return false,
                },
                Err(_) => return false,
            }
        }
    }

    /// `markerOwned`: the file at this run's marker path still says it is this run's.
    pub(super) fn marker_owned(&self) -> bool {
        let Some(marker) = self.marker_path.as_deref().and_then(read_marker) else { return false };
        pid_of(marker.get("pid")) == Some(self.pid) && marker.get("token").and_then(Value::as_str) == Some(self.token.as_str())
    }

    /// The markers a scan of the folder (and the one file older writers kept) finds, sorted into those whose process is
    /// gone and those whose pid some process holds (the pid may have been reused: its identity decides).
    pub(super) fn scan_markers(&self) -> (Vec<Marker>, Vec<Marker>) {
        let mut candidates = Vec::new();
        if let Some(paths) = &self.paths {
            if let Ok(entries) = std::fs::read_dir(&paths.marker_dir) {
                for entry in entries.flatten() {
                    let named = entry.file_name().to_string_lossy().ends_with(".json");
                    if named && entry.file_type().is_ok_and(|kind| kind.is_file()) {
                        candidates.push(entry.path());
                    }
                }
            }
            if std::fs::metadata(&paths.single_marker).is_ok() {
                candidates.push(paths.single_marker.clone());
            }
        }
        let (mut occupied, mut vanished) = (Vec::new(), Vec::new());
        for path in candidates {
            let Some(previous) = read_marker(&path) else { continue };
            let own_pid = pid_of(previous.get("pid")) == Some(self.pid);
            if own_pid && previous.get("token").and_then(Value::as_str) != Some(self.token.as_str()) {
                vanished.push(Marker { path, previous });
                continue;
            }
            // A pid that is not one a process can have proves nothing either way.
            let Some(pid) = pid_of(previous.get("pid")) else { continue };
            if self.host.process_exists(pid) {
                occupied.push(Marker { path, previous });
            } else {
                vanished.push(Marker { path, previous });
            }
        }
        (vanished, occupied)
    }

    /// Records the unclean end of every marker's process, off the thread that began the run: a start that finds many dead
    /// markers must not hold itself up in locked writes.
    pub(super) fn start_reaper(self: &Arc<Self>, vanished: Vec<Marker>, occupied: Vec<Marker>) {
        if vanished.is_empty() && occupied.is_empty() {
            return;
        }
        let run = self.clone();
        self.host.schedule(Duration::ZERO, Box::new(move || run.reap(&vanished, &occupied)));
    }

    fn reap(self: &Arc<Self>, vanished: &[Marker], occupied: &[Marker]) {
        for marker in vanished {
            self.record_prior_vanished(marker);
        }
        let mut identities: Vec<(u32, Option<Value>)> = Vec::new();
        for marker in occupied {
            if let Some(pid) = pid_of(marker.previous.get("pid"))
                && !identities.iter().any(|(known, _)| *known == pid)
            {
                identities.push((pid, self.host.identity_of(pid)));
            }
        }
        for marker in occupied {
            if !self.is_active() {
                return;
            }
            if !marker_matches(&marker.path, &marker.previous) {
                continue;
            }
            let observed = pid_of(marker.previous.get("pid")).and_then(|pid| identities.iter().find(|(known, _)| *known == pid)).and_then(|(_, identity)| identity.as_ref());
            if identity::same_identity(marker.previous.get("processIdentity"), observed) == Some(false) {
                self.record_prior_vanished(marker);
            }
        }
    }

    /// `recordPriorVanishedAsync`: the marker's process is recorded as vanished, then its marker removed; each step only while
    /// this run is still the active one and the marker is still the one that was scanned.
    fn record_prior_vanished(self: &Arc<Self>, marker: &Marker) -> bool {
        let Some(paths) = &self.paths else { return false };
        let line = format!("{}\n", mixdog_js::json_stringify(&self.prior_vanished_entry(&marker.previous)));
        let (run, path, previous, target) = (self.clone(), marker.path.clone(), marker.previous.clone(), paths.clone());
        let written = ledger::locked(paths, Wait::TwoSeconds, move || {
            if !(run.is_active() && marker_matches(&path, &previous)) {
                return false;
            }
            line.len() as u64 <= ledger::MAX_BYTES && ledger::append_line(&target, &line).unwrap_or(false)
        })
        .unwrap_or(false);
        if !written || !self.is_active() || !marker_matches(&marker.path, &marker.previous) {
            return false;
        }
        std::fs::remove_file(&marker.path).is_ok()
    }

    /// `priorVanishedEntry`.
    fn prior_vanished_entry(&self, previous: &Value) -> Value {
        let ppid = previous.get("ppid").filter(|value| value.as_f64().is_some_and(|number| number.fract() == 0.0)).cloned();
        json!({
            "version": 1,
            "timestamp": super::host::iso_from_ms(self.host.now_ms()),
            "pid": previous.get("pid").cloned(),
            "ppid": ppid,
            "reason": "prior-process-vanished",
            "exitCode": null,
        })
    }
}

/// `markerMatchesSnapshot`: the file still holds the marker that was scanned.
fn marker_matches(path: &Path, previous: &Value) -> bool {
    let Some(current) = read_marker(path) else { return false };
    current.get("pid") == previous.get("pid") && current.get("token") == previous.get("token") && current.get("processIdentity") == previous.get("processIdentity")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_pid_a_process_can_have_is_one() {
        for (value, expected) in [(json!(4242), Some(4242)), (json!(4242.0), Some(4242)), (json!(0), None), (json!(-3), None), (json!(2_147_483_648u64), None), (json!("7"), None), (json!(1.5), None)] {
            assert_eq!(pid_of(Some(&value)), expected, "{value}");
        }
        assert_eq!(pid_of(None), None);
    }

    #[test]
    fn the_rename_retries_run_for_about_four_seconds() {
        let waits: Vec<Duration> = backoffs().collect();
        assert_eq!(waits.len(), 23);
        assert_eq!(waits.iter().sum::<Duration>(), Duration::from_millis(25 + 50 + 100 + 20 * 200));
    }
}
