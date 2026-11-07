//! The read state's file store (`snapshot-store.mjs`): a session's read snapshots survive a restart as
//! `<plugin data>/read-snapshots/<scope>.json`, in Node's format. `ReadState` calls it from the
//! blocking pool, so the file calls here are the blocking calls the trait names.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use mixdog_rt::{CancellationToken, LaneToken, MaintenanceIo};
use mixdog_tools::fs::SnapshotPersist;

/// `SNAPSHOT_STALE_MS`: a scope file untouched this long is swept.
const STALE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

pub struct FileSnapshotPersist {
    dir: PathBuf,
}

/// `snapshotScopeFilePath`: the scope key with every character outside `[A-Za-z0-9._-]` replaced
/// by `_`, cut to 200 characters.
fn file_name(scope: &str) -> String {
    let safe: String = scope.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).take(200).collect();
    format!("{safe}.json")
}

/// The sweep's file calls; only ever run as a maintenance-lane job.
#[allow(clippy::disallowed_methods, reason = "runs inside a maintenance lane job")]
fn sweep_dir(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let stale = entry.metadata().and_then(|m| m.modified()).is_ok_and(|m| now.duration_since(m).is_ok_and(|age| age > STALE));
        if stale {
            let _ = std::fs::remove_file(&path);
        }
    }
}

impl FileSnapshotPersist {
    /// The store under `<data dir>/read-snapshots`; the directory is made on first save.
    pub fn new(data_dir: &Path) -> Self {
        Self { dir: data_dir.join("read-snapshots") }
    }

    /// `sweepStaleSnapshotScopes`: removes the scope files not written for 30 days. Run once at
    /// start, as a maintenance-lane job; resolves when it has run. Best effort as in Node: a lane
    /// that cannot take the job (full, wedged, cancelled) leaves the stale files for the next start.
    pub async fn sweep_stale(&self, lane: MaintenanceIo, now: SystemTime) {
        let dir = self.dir.clone();
        match lane.submit_wait(&CancellationToken::new(), move |_| sweep_dir(&dir, now)).await {
            Ok(job) => {
                if job.await.is_err() {
                    tracing::warn!("[read-snapshots] the stale-scope sweep did not run");
                }
            }
            Err(error) => tracing::warn!(?error, "[read-snapshots] the stale-scope sweep did not run"),
        }
    }
}

#[allow(clippy::disallowed_methods, reason = "ReadState calls the store from the blocking pool; the trait is blocking")]
impl SnapshotPersist for FileSnapshotPersist {
    fn load(&self, scope: &str) -> Option<String> {
        std::fs::read_to_string(self.dir.join(file_name(scope))).ok()
    }

    /// The scope keys of the files on disk (each file's name without `.json`).
    fn scopes(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        entries
            .flatten()
            .filter_map(|e| e.path().file_name()?.to_str()?.strip_suffix(".json").map(str::to_owned))
            .collect()
    }
    /// Writes beside the file and renames over it, so a reader never sees half a file. `None` removes it.
    fn save(&self, scope: &str, json: Option<&str>) {
        let path = self.dir.join(file_name(scope));
        let Some(json) = json else {
            let _ = std::fs::remove_file(&path);
            return;
        };
        if std::fs::create_dir_all(&self.dir).is_err() {
            return;
        }
        let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        if std::fs::write(&temp, json).is_ok() && std::fs::rename(&temp, &path).is_err() {
            let _ = std::fs::remove_file(&temp);
        }
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod tests {
    use super::*;

    #[test]
    fn a_scope_round_trips_and_an_empty_one_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSnapshotPersist::new(dir.path());
        assert_eq!(store.load("s/1"), None);
        store.save("s/1", Some("{\"a\":1}"));
        assert_eq!(store.load("s/1").as_deref(), Some("{\"a\":1}"));
        assert!(dir.path().join("read-snapshots").join("s_1.json").is_file());
        assert_eq!(store.scopes(), ["s_1"]);
        store.save("s/1", None);
        assert_eq!(store.load("s/1"), None);
        assert!(store.scopes().is_empty());
    }

    #[test]
    fn the_file_name_follows_node() {
        assert_eq!(file_name("a b/ü.c-d_e"), "a_b__.c-d_e.json");
        assert_eq!(file_name(&"x".repeat(300)).len(), 200 + ".json".len());
    }

    #[tokio::test]
    async fn only_scopes_older_than_thirty_days_are_swept() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSnapshotPersist::new(dir.path());
        store.save("new", Some("{}"));
        // The old scope's file is made through the temp file's handle, which carries the mtime.
        let (old, path) = tempfile::Builder::new()
            .prefix("old-")
            .suffix(".json")
            .tempfile_in(dir.path().join("read-snapshots"))
            .unwrap()
            .keep()
            .unwrap();
        old.set_modified(SystemTime::now() - Duration::from_secs(31 * 24 * 60 * 60)).unwrap();
        let old = path.file_stem().unwrap().to_str().unwrap().to_owned();
        store.sweep_stale(mixdog_rt::testing::tokens().maintenance_io, SystemTime::now()).await;
        assert_eq!(store.load(&old), None);
        assert!(store.load("new").is_some());
    }
}