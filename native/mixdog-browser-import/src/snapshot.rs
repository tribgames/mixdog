//! Consistent snapshot of a Chromium SQLite database.
//!
//! Copying the database file and its `-wal`/`-shm` siblings one by one is not a
//! point-in-time image while Chrome writes or checkpoints: rows can go missing
//! or the copy can be unreadable. Instead the live file is opened read-only and
//! `VACUUM INTO` writes a complete private copy inside SQLite's own locking, so
//! the copy is either consistent or the call fails. A database still locked by
//! a running Chrome is reported as [`Failure::ChromeRunning`]; any other open
//! or read problem is [`Failure::DataUnreadable`]. SQLite's own error text is
//! never forwarded.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Result};
use rusqlite::{Connection, ErrorCode, OpenFlags};
use windows::Win32::Foundation::{ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION};

use crate::failure::Failure;

/// A snapshot file, deleted together with any SQLite sidecar files on drop.
pub struct Snapshot {
    path: PathBuf,
}

impl Snapshot {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let mut sibling = self.path.clone().into_os_string();
            sibling.push(suffix);
            let _ = std::fs::remove_file(sibling);
        }
    }
}

/// Whether another process holds `path` open without sharing it. Chrome does
/// this to its databases, and SQLite folds the resulting Windows sharing or
/// lock violation into a generic "cannot open".
fn held_by_another_process(path: &Path) -> bool {
    match std::fs::File::open(path) {
        Err(error) => [ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION]
            .iter()
            .any(|code| error.raw_os_error() == Some(code.0 as i32)),
        Ok(_) => false,
    }
}

/// Classify a SQLite failure on the live database. Only a genuine lock means
/// Chrome is running; read-only, permission, I/O and corruption failures
/// (for example a WAL `-shm` that cannot be created) are unreadable data.
fn failure_for(src: &Path, error: &rusqlite::Error) -> Failure {
    match error {
        rusqlite::Error::SqliteFailure(failure, _) => match failure.code {
            ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => Failure::ChromeRunning,
            ErrorCode::CannotOpen if held_by_another_process(src) => Failure::ChromeRunning,
            _ => Failure::DataUnreadable,
        },
        _ => Failure::DataUnreadable,
    }
}

fn snapshot_into(src: &Path, dest: PathBuf) -> Result<Snapshot> {
    // Built first so every failure below removes whatever `VACUUM INTO` left.
    let snapshot = Snapshot { path: dest };
    let target = snapshot
        .path
        .to_str()
        .ok_or_else(|| anyhow!("the temporary snapshot path is not valid UTF-8"))?;
    let live = Connection::open_with_flags(src, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| failure_for(src, &error))?;
    // rusqlite installs a 5 s busy handler on every connection it opens. A lock
    // here means Chrome has the database open for as long as it runs, so
    // waiting cannot help: remove the handler (a timeout <= 0 "turns off all
    // busy handlers", sqlite.org/c3ref/busy_timeout.html) so SQLITE_BUSY is
    // returned at once, which is SQLite's default, and reported as ChromeRunning.
    live.busy_timeout(Duration::ZERO)
        .map_err(|error| failure_for(src, &error))?;
    live.execute("VACUUM INTO ?1", [target])
        .map_err(|error| failure_for(src, &error))?;
    Ok(snapshot)
}

/// Write a consistent snapshot of the database at `src` to a fresh temporary
/// file. `kind` names the database in the temp file name.
pub fn snapshot(src: &Path, kind: &str) -> Result<Snapshot> {
    let dest = std::env::temp_dir().join(format!(
        "mixdog-{kind}-{:016x}.db",
        rand::random::<u64>()
    ));
    snapshot_into(src, dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("mx-snap-{:016x}", rand::random::<u64>()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn values(path: &Path) -> Vec<String> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut statement = conn.prepare("SELECT v FROM t ORDER BY id").unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap()
    }

    #[test]
    fn snapshot_contains_uncheckpointed_wal_rows_and_is_removed_on_drop() {
        let dir = TestDir::new();
        let live = dir.join("Login Data");
        let writer = Connection::open(&live).unwrap();
        writer
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
                 CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);
                 INSERT INTO t (v) VALUES ('first');
                 INSERT INTO t (v) VALUES ('second');",
            )
            .unwrap();
        assert!(std::fs::metadata(dir.join("Login Data-wal")).unwrap().len() > 0);

        let copy = snapshot(&live, "login").unwrap();
        assert_eq!(values(copy.path()), ["first", "second"]);

        // The copy and any sidecars SQLite leaves beside it go away together.
        let path = copy.path().to_path_buf();
        let sidecars = ["-wal", "-shm", "-journal"].map(|suffix| {
            let mut sidecar = path.clone().into_os_string();
            sidecar.push(suffix);
            PathBuf::from(sidecar)
        });
        for sidecar in &sidecars {
            std::fs::write(sidecar, b"x").unwrap();
        }
        drop(copy);
        assert!(!path.exists());
        assert!(sidecars.iter().all(|sidecar| !sidecar.exists()));
        drop(writer);
    }

    fn failure_of(result: Result<Snapshot>) -> Failure {
        let error = result.err().expect("the snapshot must fail");
        *error
            .downcast_ref::<Failure>()
            .unwrap_or_else(|| panic!("unclassified snapshot error: {error:?}"))
    }

    #[test]
    fn locked_database_reports_chrome_running_without_leaving_a_copy() {
        let dir = TestDir::new();
        let live = dir.join("Cookies");
        let writer = Connection::open(&live).unwrap();
        writer
            .execute_batch(
                "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);
                 INSERT INTO t (v) VALUES ('x');
                 BEGIN EXCLUSIVE;",
            )
            .unwrap();

        let dest = dir.join("copy.db");
        let failure = failure_of(snapshot_into(&live, dest.clone()));
        assert_eq!(failure, Failure::ChromeRunning);
        assert!(!dest.exists());

        // Once the lock is released the same snapshot succeeds.
        writer.execute_batch("COMMIT").unwrap();
        let copy = snapshot_into(&live, dest).unwrap();
        assert_eq!(values(copy.path()), ["x"]);
    }

    #[test]
    fn file_held_without_sharing_reports_chrome_running() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = TestDir::new();
        let live = dir.join("Cookies");
        Connection::open(&live)
            .unwrap()
            .execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);")
            .unwrap();
        // How a running Chrome holds its database: open with no sharing.
        let _held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&live)
            .unwrap();

        let dest = dir.join("copy.db");
        let failure = failure_of(snapshot_into(&live, dest.clone()));
        assert_eq!(failure, Failure::ChromeRunning);
        assert!(!dest.exists());
    }

    #[test]
    fn unreadable_databases_are_not_blamed_on_a_running_chrome() {
        let dir = TestDir::new();
        let dest = dir.join("copy.db");

        // Not a database at all.
        let garbage = dir.join("Garbage");
        std::fs::write(&garbage, vec![0x5a_u8; 4096]).unwrap();
        assert_eq!(
            failure_of(snapshot_into(&garbage, dest.clone())),
            Failure::DataUnreadable
        );

        // A path SQLite cannot open for a reason other than a sharing lock.
        assert_eq!(
            failure_of(snapshot_into(&dir.0, dest.clone())),
            Failure::DataUnreadable
        );
        assert!(!dest.exists());
    }

    #[test]
    fn only_locks_classify_as_chrome_running() {
        use rusqlite::ffi;

        let dir = TestDir::new();
        let readable = dir.join("Readable");
        std::fs::write(&readable, b"x").unwrap();
        let sqlite = |code| rusqlite::Error::SqliteFailure(ffi::Error::new(code), None);

        for locked in [ffi::SQLITE_BUSY, ffi::SQLITE_LOCKED] {
            assert_eq!(failure_for(&readable, &sqlite(locked)), Failure::ChromeRunning);
        }
        // Read-only (a WAL -shm that cannot be created), permission, I/O and
        // corruption failures, and a plain cannot-open on a readable file.
        for unreadable in [
            ffi::SQLITE_READONLY,
            ffi::SQLITE_READONLY_CANTINIT,
            ffi::SQLITE_READONLY_RECOVERY,
            ffi::SQLITE_PERM,
            ffi::SQLITE_IOERR,
            ffi::SQLITE_CORRUPT,
            ffi::SQLITE_NOTADB,
            ffi::SQLITE_CANTOPEN,
        ] {
            assert_eq!(
                failure_for(&readable, &sqlite(unreadable)),
                Failure::DataUnreadable,
                "code {unreadable}"
            );
        }
        assert_eq!(
            failure_for(&readable, &rusqlite::Error::InvalidQuery),
            Failure::DataUnreadable
        );
    }

    #[test]
    fn missing_database_is_unreadable_and_is_not_created() {
        let dir = TestDir::new();
        let live = dir.join("Missing");
        let dest = dir.join("copy.db");
        assert_eq!(
            failure_of(snapshot_into(&live, dest.clone())),
            Failure::DataUnreadable
        );
        assert!(!live.exists());
        assert!(!dest.exists());
    }
}
