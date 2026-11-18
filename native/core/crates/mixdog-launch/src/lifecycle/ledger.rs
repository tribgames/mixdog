//! The ledger file: JSON lines in `process-lifecycle.jsonl`, appended under a file lock, kept to 64 KiB by moving the full
//! file to `process-lifecycle.jsonl.1` (one generation is retained), exactly as `process-lifecycle.mjs` keeps it.

use std::fs;
use std::fs::OpenOptions;
use std::io;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use mixdog_statefile::LockHold;
use mixdog_statefile::LockOpts;

/// `LIFECYCLE_LEDGER_MAX_BYTES`.
pub(super) const MAX_BYTES: u64 = 64 * 1024;
/// How long a lock waits for another holder, where waiting is allowed (`LEDGER_LOCK_TIMEOUT_MS`).
const LOCK_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a lock that names no owner lives (`LEDGER_LOCK_STALE_MS`).
const LOCK_STALE: Duration = Duration::from_secs(10);
/// How often an asynchronous wait looks at the lock thread's answer.
const POLL: Duration = Duration::from_millis(2);

/// Where the files of one ledger are.
#[derive(Clone, Debug)]
pub(super) struct Paths {
    pub dir: PathBuf,
    pub ledger: PathBuf,
    pub previous: PathBuf,
    pub marker_dir: PathBuf,
    /// The single marker file kept by writers before the folder of markers (`process-lifecycle.active.json`).
    pub single_marker: PathBuf,
    pub lock: PathBuf,
}

impl Paths {
    pub fn in_dir(dir: PathBuf) -> Self {
        Self {
            ledger: dir.join("process-lifecycle.jsonl"),
            previous: dir.join("process-lifecycle.jsonl.1"),
            marker_dir: dir.join("process-lifecycle.active"),
            single_marker: dir.join("process-lifecycle.active.json"),
            lock: dir.join("process-lifecycle.lock"),
            dir,
        }
    }
}

/// `mkdirSync(dir, { recursive: true, mode: 0o700 })`.
pub(super) fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}

/// A file opened for writing that only its owner can read where the platform says so (`mode: 0o600`).
fn open_private(path: &Path, options: &mut OpenOptions) -> io::Result<fs::File> {
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(options, 0o600);
    options.open(path)
}

/// `writeFileSync(path, '', { mode: 0o600 })`.
fn write_empty(path: &Path) -> io::Result<()> {
    open_private(path, OpenOptions::new().write(true).create(true).truncate(true)).map(drop)
}

fn file_size(path: &Path) -> io::Result<u64> {
    fs::metadata(path).map(|meta| meta.len())
}

fn exists(path: &Path) -> bool {
    fs::metadata(path).is_ok()
}

/// `rotateLedger`: the full ledger becomes the retained generation.
fn rotate(paths: &Paths) -> io::Result<()> {
    let size = file_size(&paths.ledger)?;
    let _ = fs::remove_file(&paths.previous);
    if size <= MAX_BYTES {
        return fs::rename(&paths.ledger, &paths.previous);
    }
    // An oversized file cannot have been produced by this writer: an untrusted or partial record is not carried into the
    // retained generation.
    write_empty(&paths.previous)?;
    fs::remove_file(&paths.ledger)
}

/// `appendLedgerLine`, inside a held lock: the retained generation is bounded, the ledger rotates when this line would
/// overflow it, then the line is written. Whether the ledger is still within its bound.
pub(super) fn append_line(paths: &Paths, line: &str) -> io::Result<bool> {
    if exists(&paths.previous) && file_size(&paths.previous)? > MAX_BYTES {
        write_empty(&paths.previous)?;
    }
    if exists(&paths.ledger) && file_size(&paths.ledger)? + line.len() as u64 > MAX_BYTES {
        rotate(paths)?;
    }
    let mut file = open_private(&paths.ledger, OpenOptions::new().append(true).create(true))?;
    file.write_all(line.as_bytes())?;
    drop(file);
    Ok(file_size(&paths.ledger)? <= MAX_BYTES)
}

/// How long a locked append waits for another holder of the lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Wait {
    /// Not at all: a try-lock, for the writes that cannot wait (the start, a fatal, the end).
    Never,
    /// Up to two seconds, for the writes of a background job.
    TwoSeconds,
}

/// Runs `body` on the lock's own thread once the lock is held. The answer comes on the channel: `Some` of what `body`
/// returned, `None` when the lock was not taken. The hold releases the lock when dropped.
fn hold<R: Send + 'static>(paths: &Paths, wait: Wait, body: impl FnOnce() -> R + Send + 'static) -> (mpsc::Receiver<Option<R>>, LockHold) {
    let (answer, receive) = mpsc::channel();
    let opts = LockOpts {
        timeout: Some(if wait == Wait::Never { Duration::ZERO } else { LOCK_TIMEOUT }),
        stale: Some(LOCK_STALE),
        strict_owner: false,
    };
    let acquired = move |taken: Result<(), mixdog_statefile::LockError>| {
        let _ = answer.send(taken.ok().map(|()| body()));
    };
    let lock_hold = if wait == Wait::Never {
        // `withFileLockSync`: one deadline from the call.
        mixdog_statefile::hold_lock_one_deadline(&paths.lock, &opts, acquired)
    } else {
        mixdog_statefile::hold_lock(&paths.lock, &opts, acquired)
    };
    (receive, lock_hold)
}

/// `withFileLockSync` / `withFileLock` around `body`: the thread waits for the lock (never longer than `wait` says) and for
/// `body`. `None` when the lock was not taken.
pub(super) fn locked<R: Send + 'static>(paths: &Paths, wait: Wait, body: impl FnOnce() -> R + Send + 'static) -> Option<R> {
    let (receive, hold) = hold(paths, wait, body);
    // The lock thread answers exactly once, when it holds the lock or when it gave up: its own deadline bounds this wait.
    let answer = receive.recv().ok().flatten();
    drop(hold);
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> (tempfile::TempDir, Paths) {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::in_dir(temp.path().join("diagnostics"));
        create_private_dir(&paths.dir).unwrap();
        (temp, paths)
    }

    fn filled(path: &Path, bytes: usize) {
        fs::write(path, "x".repeat(bytes)).unwrap();
    }

    #[test]
    fn a_line_is_appended_while_the_ledger_has_room() {
        let (_temp, paths) = paths();
        assert!(append_line(&paths, "{\"a\":1}\n").unwrap());
        assert!(append_line(&paths, "{\"b\":2}\n").unwrap());
        assert_eq!(fs::read_to_string(&paths.ledger).unwrap(), "{\"a\":1}\n{\"b\":2}\n");
        assert!(!exists(&paths.previous));
    }

    #[test]
    fn a_full_ledger_becomes_the_retained_generation_and_the_old_one_is_dropped() {
        let (_temp, paths) = paths();
        filled(&paths.previous, 10);
        filled(&paths.ledger, MAX_BYTES as usize - 5);
        assert!(append_line(&paths, "123456\n").unwrap());
        assert_eq!(file_size(&paths.previous).unwrap(), MAX_BYTES - 5);
        assert_eq!(fs::read_to_string(&paths.ledger).unwrap(), "123456\n");
    }

    #[test]
    fn a_ledger_that_fits_exactly_is_not_rotated() {
        let (_temp, paths) = paths();
        filled(&paths.ledger, MAX_BYTES as usize - 7);
        assert!(append_line(&paths, "123456\n").unwrap());
        assert!(!exists(&paths.previous));
        assert_eq!(file_size(&paths.ledger).unwrap(), MAX_BYTES);
    }

    #[test]
    fn an_oversized_ledger_leaves_an_empty_generation_not_its_bytes() {
        let (_temp, paths) = paths();
        filled(&paths.ledger, MAX_BYTES as usize + 100);
        assert!(append_line(&paths, "123456\n").unwrap());
        assert_eq!(file_size(&paths.previous).unwrap(), 0);
        assert_eq!(fs::read_to_string(&paths.ledger).unwrap(), "123456\n");
    }

    #[test]
    fn an_oversized_retained_generation_is_emptied() {
        let (_temp, paths) = paths();
        filled(&paths.previous, MAX_BYTES as usize + 1);
        assert!(append_line(&paths, "123456\n").unwrap());
        assert_eq!(file_size(&paths.previous).unwrap(), 0);
    }

    #[test]
    fn appends_from_many_threads_each_land_whole_and_the_bound_holds() {
        let (_temp, paths) = paths();
        fs::write(&paths.ledger, format!("{}\n", "x".repeat(MAX_BYTES as usize - 601))).unwrap();
        let threads: Vec<_> = (0..8)
            .map(|n| {
                let paths = paths.clone();
                std::thread::spawn(move || {
                    for i in 0..10 {
                        let line = format!("{{\"thread\":{n},\"i\":{i},\"pad\":\"{}\"}}\n", "p".repeat(40));
                        let target = paths.clone();
                        assert_eq!(locked(&paths, Wait::TwoSeconds, move || append_line(&target, &line).unwrap()), Some(true));
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let ledger = fs::read_to_string(&paths.ledger).unwrap();
        let previous = fs::read_to_string(&paths.previous).unwrap_or_default();
        assert!(ledger.len() as u64 <= MAX_BYTES && previous.len() as u64 <= MAX_BYTES);
        // The seed was one long line of `x`; every other line is a whole record, and none was lost to the one rotation.
        let records = |text: &str| text.lines().filter(|line| line.starts_with('{') && line.ends_with('}')).count();
        assert_eq!(records(&ledger) + records(&previous), 80);
    }

    #[test]
    fn a_try_lock_gives_up_while_another_holds_the_lock() {
        let (_temp, paths) = paths();
        let (release, released) = mpsc::channel::<()>();
        let (held_answer, held) = mpsc::channel();
        let target = paths.clone();
        let holder = std::thread::spawn(move || {
            locked(&target, Wait::TwoSeconds, move || {
                held_answer.send(()).unwrap();
                released.recv().unwrap();
            })
        });
        held.recv().unwrap();
        assert_eq!(locked(&paths, Wait::Never, || 1), None);
        release.send(()).unwrap();
        assert_eq!(holder.join().unwrap(), Some(()));
        assert_eq!(locked(&paths, Wait::Never, || 1), Some(1));
    }
}


/// [`locked`] for a caller on an executor: the wait is a sleep, not a block of the thread.
pub(super) async fn locked_async<R: Send + 'static>(paths: &Paths, body: impl FnOnce() -> R + Send + 'static) -> Option<R> {
    let (receive, hold) = hold(paths, Wait::TwoSeconds, body);
    let answer = loop {
        match receive.try_recv() {
            Ok(answer) => break answer,
            Err(mpsc::TryRecvError::Empty) => mixdog_rt::time::sleep(POLL).await,
            Err(mpsc::TryRecvError::Disconnected) => break None,
        }
    };
    drop(hold);
    answer
}
