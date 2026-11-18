//! The live-session refcount of the staged update (`registerLiveSession` of 1.4.5's `staged-update.mjs`).
//!
//! The update of an npm install is staged by the core (`npm install` into `<data>/staging/<version>`) and swapped in by the package's
//! launcher (`bin/staged-swap.mjs`) at the next clean start. The swap never replaces the package under a program that runs, and it
//! learns that from the pid files this module writes: `<data>/live-sessions/<pid>.pid`, `<pid> <ms>\n`, removed when the last session
//! of this process is dropped. A pid file of a process that is gone is reaped by the swap.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

/// The live sessions of this process, per live-sessions folder.
static LIVE_SESSIONS: Mutex<BTreeMap<PathBuf, BTreeSet<String>>> = Mutex::new(BTreeMap::new());

/// A live session of this process (`registerLiveSession`). The pid file stays while any session of this process is registered and is
/// removed when the last one is dropped (`unregisterLiveSession`).
pub struct LiveSession {
    pid_file: Option<PathBuf>,
    dir: PathBuf,
    id: String,
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        let mut registry = LIVE_SESSIONS.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(ids) = registry.get_mut(&self.dir) else { return };
        ids.remove(&self.id);
        if ids.is_empty() {
            registry.remove(&self.dir);
            if let Some(file) = self.pid_file.take() {
                drop(std::fs::remove_file(file));
            }
        }
    }
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis())
}

/// `registerLiveSession()` over the live-sessions folder `dir`.
fn register_in(dir: &Path, id: &str) -> LiveSession {
    let mut registry = LIVE_SESSIONS.lock().unwrap_or_else(PoisonError::into_inner);
    registry.entry(dir.to_path_buf()).or_default().insert(id.to_owned());
    let pid_file = dir.join(format!("{}.pid", std::process::id()));
    // Advisory: a refcount that cannot be written only means no one sees this session.
    let written = std::fs::create_dir_all(dir).and_then(|()| std::fs::write(&pid_file, format!("{} {}\n", std::process::id(), now_ms())));
    drop(written);
    LiveSession { pid_file: Some(pid_file), dir: dir.to_path_buf(), id: id.to_owned() }
}

/// `registerLiveSession()` for this process. Without a data folder nothing is written and the session is only counted.
pub fn register_live_session(id: &str) -> LiveSession {
    match crate::crash_capture::paths::data_dir() {
        Some(data_dir) => register_in(&data_dir.join("live-sessions"), id),
        None => {
            LIVE_SESSIONS.lock().unwrap_or_else(PoisonError::into_inner).entry(PathBuf::new()).or_default().insert(id.to_owned());
            LiveSession { pid_file: None, dir: PathBuf::new(), id: id.to_owned() }
        }
    }
}

/// How many sessions of this process are registered.
pub fn live_sessions() -> usize {
    LIVE_SESSIONS.lock().unwrap_or_else(PoisonError::into_inner).values().map(BTreeSet::len).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_refcount_is_one_pid_file_for_as_long_as_a_session_of_this_process_is_registered() {
        let root = tempfile::tempdir().expect("temp dir");
        let live = root.path().join("live-sessions");
        let pid_file = live.join(format!("{}.pid", std::process::id()));
        let first = register_in(&live, "a");
        let text = std::fs::read_to_string(&pid_file).expect("pid file");
        let (pid, rest) = text.trim_end().split_once(' ').expect("pid and ms");
        assert_eq!(pid, std::process::id().to_string());
        assert!(rest.parse::<u128>().is_ok() && text.ends_with('\n'));
        let second = register_in(&live, "b");
        drop(first);
        assert!(pid_file.is_file(), "a session is still registered");
        drop(second);
        assert!(!pid_file.exists(), "the last session removes the file");
        // Registered again, then unregistered twice over: the file is gone and stays gone.
        let again = register_in(&live, "a");
        drop(again);
        assert!(!pid_file.exists());
    }
}