//! Node's cross-process advisory lock (`builtin/advisory-lock.mjs`, `withAdvisoryLocks`) for one path: a lock file
//! created exclusively in the user's local mixdog directory, named by the hash of the target's real location (the
//! name and the holder's token are the ones the Node and tool locks use, so every process of the user agrees on it),
//! whose holder is probed for liveness so a crashed process never wedges its path.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every std::fs call is the body of a lane job, bar the one unlink in Drop")]

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use mixdog_rt::MaintenanceIo;
use mixdog_workspace::pathguard::canonical;
use mixdog_workspace::pathguard::lexical;
use sha2::Digest;
use sha2::Sha256;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::repo::on_lane;
use crate::worktree::ownership::pid_alive_or_unknown;

const POLL: Duration = Duration::from_millis(25);
/// Node waits 5 s for a held lock (`acquireAdvisoryLock` `timeoutMs`).
const TIMEOUT: Duration = Duration::from_millis(5000);

/// `ensurePrivateRuntimeRoot`: the lock folder is the user's own, mode 0700 on unix.
fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        let meta = std::fs::symlink_metadata(dir)?;
        // SAFETY: getuid has no preconditions.
        if !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } {
            return Err(std::io::Error::other(format!("runtime root is not owned by the current user: {}", dir.display())));
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

/// `lockDirectory`: the OS user's local home, never beside the target.
fn lock_directory() -> PathBuf {
    if cfg!(windows) {
        let local = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()).map(PathBuf::from);
        let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
        local.unwrap_or_else(|| home.join("AppData").join("Local")).join("mixdog").join("locks")
    } else {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".mixdog").join("locks")
    }
}

/// `canonicalLockTarget`: the deepest existing component resolved, the components not created yet as given.
fn canonical_lock_target(path: &Path) -> PathBuf {
    let resolved = lexical(path);
    let mut tail: Vec<OsString> = Vec::new();
    let mut dir = resolved.clone();
    loop {
        if let Ok(real) = canonical(&dir) {
            return tail.iter().rev().fold(real, |acc, part| acc.join(part));
        }
        let (Some(parent), Some(name)) = (dir.parent().map(Path::to_path_buf), dir.file_name().map(OsString::from)) else {
            return resolved;
        };
        tail.push(name);
        dir = parent;
    }
}

fn lock_file_for(dir: &Path, target: &Path) -> PathBuf {
    let real = canonical_lock_target(target).to_string_lossy().into_owned();
    let key = if cfg!(windows) { real.to_lowercase() } else { real };
    let hash: String = Sha256::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    dir.join(format!("{hash}.mixdog-lock"))
}

/// `parseInt(token, 10)` as a whole number, else 0: the holder's pid leads its token.
fn holder_pid(token: &str) -> i64 {
    let digits: String = token.trim().chars().take_while(char::is_ascii_digit).collect();
    digits.parse().unwrap_or(0)
}

fn holder_dead(pid: i64) -> bool {
    match u32::try_from(pid) {
        Ok(pid) if pid > 0 => !(0..3).any(|_| pid_alive_or_unknown(Some(pid))),
        _ => true,
    }
}

fn read_token(file: &Path) -> String {
    std::fs::read(file).map(|bytes| String::from_utf8_lossy(&bytes).trim().to_owned()).unwrap_or_default()
}

/// A held lock file, released on drop while it still carries this holder's token.
#[must_use = "the path stays locked while the guard lives"]
pub(crate) struct PathLock {
    file: PathBuf,
    token: String,
}

impl Drop for PathLock {
    fn drop(&mut self) {
        if read_token(&self.file) == self.token {
            let _ = std::fs::remove_file(&self.file);
        }
    }
}

enum Attempt {
    Taken(PathBuf),
    Held(PathBuf, String),
}

/// `${pid}.${randomBytes(8).toString('hex')}`: sixteen hex digits after the pid.
fn new_token() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let unique = (nanos as u64) ^ COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!("{}.{unique:016x}", std::process::id())
}

async fn try_create(lane: MaintenanceIo, dir: &Path, target: &Path, token: &str, cancel: &CancellationToken) -> Result<Attempt, ScmFailure> {
    let (root, owned, mine) = (dir.to_path_buf(), target.to_path_buf(), token.to_owned());
    on_lane(lane, cancel, move || -> std::io::Result<Attempt> {
        ensure_private_dir(&root)?;
        let file = lock_file_for(&root, &owned);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&file) {
            Ok(mut created) => {
                use std::io::Write;
                if let Err(error) = created.write_all(mine.as_bytes()) {
                    drop(created);
                    let _ = std::fs::remove_file(&file);
                    return Err(error);
                }
                Ok(Attempt::Taken(file))
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let held = read_token(&file);
                Ok(Attempt::Held(file, held))
            }
            Err(error) => Err(error),
        }
    })
    .await?
    .map_err(|error| ScmFailure::git(format!("Error: advisory lock: {error}")))
}
impl PathLock {
    /// `withAdvisoryLocks([target])`: waits for a live holder (up to Node's 5 s), reclaims a dead one's.
    pub(crate) async fn acquire(lane: MaintenanceIo, target: &Path, cancel: &CancellationToken) -> Result<Self, ScmFailure> {
        Self::acquire_in(lane, &lock_directory(), target, TIMEOUT, cancel).await
    }

    /// `acquireAdvisoryLock`, step for step (`advisory-lock.mjs:124-199`).
    async fn acquire_in(lane: MaintenanceIo, dir: &Path, target: &Path, timeout: Duration, cancel: &CancellationToken) -> Result<Self, ScmFailure> {
        let token = new_token();
        let deadline = std::time::Instant::now() + timeout;
        let mut stale_retry_used = false;
        let timed_out =
            |file: &Path, pid: i64| ScmFailure::git(format!("Error: advisory lock timeout: {} ({}) held by pid {pid}", target.display(), file.display()));
        loop {
            let attempt = try_create(lane, dir, target, &token, cancel).await?;
            let (file, held) = match attempt {
                Attempt::Taken(file) => return Ok(Self { file, token }),
                Attempt::Held(file, held) => (file, held),
            };
            let pid = holder_pid(&held);
            if holder_dead(pid) {
                // Under load a live holder can probe dead once: pause, read again, and reclaim only when the
                // holder is unchanged and dead on a second probe.
                mixdog_rt::time::sleep(Duration::from_millis(50)).await;
                let again = file.clone();
                let second = on_lane(lane, cancel, move || read_token(&again)).await?;
                if second != held {
                    if std::time::Instant::now() >= deadline {
                        let second_pid = holder_pid(&second);
                        return Err(timed_out(&file, if second_pid != 0 { second_pid } else { pid }));
                    }
                    continue;
                }
                if holder_dead(pid) {
                    let (stale, expected) = (file.clone(), held.clone());
                    on_lane(lane, cancel, move || {
                        if read_token(&stale) == expected {
                            let _ = std::fs::remove_file(&stale);
                        }
                    })
                    .await?;
                    mixdog_rt::time::sleep(Duration::from_millis(1 + u64::from(std::process::id()) % 5)).await;
                    if std::time::Instant::now() < deadline {
                        continue;
                    }
                    // Past the deadline exactly one more attempt is granted.
                    if !stale_retry_used {
                        stale_retry_used = true;
                        continue;
                    }
                    return Err(timed_out(&file, pid));
                }
            }
            if std::time::Instant::now() >= deadline {
                return Err(timed_out(&file, pid));
            }
            mixdog_rt::time::sleep(POLL).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lane() -> MaintenanceIo {
        mixdog_rt::testing::tokens().maintenance_io
    }

    #[tokio::test]
    async fn a_held_path_waits_for_its_holder_and_a_dead_holders_lock_is_reclaimed() {
        let dir = tempfile::tempdir().unwrap();
        let (locks, target) = (dir.path().join("locks"), dir.path().join("folder"));
        std::fs::create_dir_all(&target).unwrap();
        let cancel = CancellationToken::new();
        let held = PathLock::acquire_in(lane(), &locks, &target, Duration::from_millis(100), &cancel).await.unwrap();
        let file = lock_file_for(&locks, &target);
        assert!(file.exists());
        let refused = PathLock::acquire_in(lane(), &locks, &target, Duration::from_millis(100), &cancel).await.err().expect("a held path is not shared");
        assert!(refused.to_string().contains("advisory lock timeout"), "{refused}");
        drop(held);
        assert!(!file.exists(), "released with the guard");
        // A holder that is not a live process (no pid at all) never wedges the path.
        std::fs::write(&file, "0.stale").unwrap();
        drop(PathLock::acquire_in(lane(), &locks, &target, Duration::from_millis(100), &cancel).await.expect("a dead holder's lock is reclaimed"));
    }
}
