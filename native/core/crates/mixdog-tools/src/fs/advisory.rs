//! Node's cross-process advisory lock (`builtin/advisory-lock.mjs`): a lock file created
//! exclusively in the user's local mixdog directory, named by the hash of the target's real
//! location, whose holder is probed for liveness so a crashed process never wedges its path.
//! Every `std::fs` call is the body of a durability-lane job, except the release in `Drop`,
//! which cannot await one.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "every std::fs call is a durability-lane job body, bar the one unlink in Drop"
)]

use std::ffi::OsString;
use std::fs;
use std::io;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_js::js_trim;
use mixdog_scm::worktree::ownership::pid_alive_or_unknown;
use mixdog_workspace::pathguard::canonical;
use mixdog_workspace::pathguard::lexical;
use sha2::Digest;
use sha2::Sha256;

use super::common::*;
use super::os_error::io_message;
use super::patch_guard::on_lane;

const TIMEOUT: Duration = Duration::from_millis(5000);
const POLL: Duration = Duration::from_millis(25);

/// `lockDirectory`: the OS user's local home, never beside the target.
pub(super) fn lock_directory() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    if cfg!(windows) {
        let local = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()).map(PathBuf::from);
        local.unwrap_or_else(|| home.join("AppData").join("Local")).join("mixdog").join("locks")
    } else {
        home.join(".mixdog").join("locks")
    }
}

/// Node `canonicalLockTarget`: the deepest existing component (the target itself when present, so
/// a leaf symlink shares its referent's lock) resolved, the components not created yet as given.
pub(super) fn canonical_lock_target(path: &Path) -> PathBuf {
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

pub(super) fn lock_file_for(dir: &Path, target: &Path) -> PathBuf {
    let real = canonical_lock_target(target).to_string_lossy().into_owned();
    let key = if cfg!(windows) { real.to_lowercase() } else { real };
    let hash: String = Sha256::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    dir.join(format!("{hash}.mixdog-lock"))
}

/// `ensurePrivateRuntimeRoot`.
fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        let meta = fs::symlink_metadata(dir)?;
        // SAFETY: getuid has no preconditions.
        if !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } {
            return Err(io::Error::other(format!("runtime root is not owned by the current user: {}", dir.display())));
        }
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

struct LockInfo {
    pid: i64,
    token: String,
}

/// `parseInt(raw, 10)` as a whole number, else 0.
fn leading_int(raw: &str) -> i64 {
    let (sign, digits) = match raw.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, raw.strip_prefix('+').unwrap_or(raw)),
    };
    let end = digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len());
    digits[..end].parse::<i64>().map_or(0, |n| sign * n)
}

/// `isPidAlive`: a non-positive pid is dead; three probes, any success is alive.
fn pid_alive(pid: i64) -> bool {
    match u32::try_from(pid) {
        Ok(pid) if pid > 0 => (0..3).any(|_| pid_alive_or_unknown(Some(pid))),
        _ => false,
    }
}

fn read_lock_info(lock_file: &Path) -> LockInfo {
    match fs::read(lock_file) {
        Ok(bytes) => {
            let raw = js_trim(&String::from_utf8_lossy(&bytes)).to_owned();
            LockInfo { pid: leading_int(&raw), token: raw }
        }
        Err(_) => LockInfo { pid: 0, token: String::new() },
    }
}

fn unlink_if_owned(lock_file: &Path, expected: &str) -> bool {
    read_lock_info(lock_file).token == expected && fs::remove_file(lock_file).is_ok()
}

fn try_create_lock(lock_file: &Path, token: &str) -> io::Result<bool> {
    let mut file = match fs::OpenOptions::new().write(true).create_new(true).open(lock_file) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(e),
    };
    if let Err(e) = file.write_all(token.as_bytes()) {
        drop(file);
        let _ = fs::remove_file(lock_file);
        return Err(e);
    }
    Ok(true)
}

/// A held lock file, released on drop while it still carries this holder's token.
pub(super) struct Advisory {
    held: Vec<(PathBuf, String)>,
}

impl Drop for Advisory {
    fn drop(&mut self) {
        for (file, token) in self.held.iter().rev() {
            unlink_if_owned(file, token);
        }
    }
}

fn failure(error: &io::Error, syscall: &str, path: &Path) -> ToolError {
    fail(ToolErrorCode::Io { os_code: error.raw_os_error() }, format!("Error: {}", io_message(error, syscall, Some(path))))
}

fn timeout_error(target: &Path, lock_file: &Path, holder: i64) -> ToolError {
    fail(
        ToolErrorCode::Io { os_code: None },
        format!("Error: advisory lock timeout: {} ({}) held by pid {holder}", target.display(), lock_file.display()),
    )
}

async fn pause(ctx: &ToolContext, wait: Duration) -> Result<(), ToolError> {
    tokio::select! {
        () = mixdog_rt::time::sleep(wait) => Ok(()),
        () = ctx.cancel.cancelled() => Err(cancelled()),
    }
}

async fn read_info(ctx: &ToolContext, lock_file: &Path) -> Result<(LockInfo, bool), ToolError> {
    let file = lock_file.to_path_buf();
    on_lane(ctx, move || {
        let info = read_lock_info(&file);
        let alive = pid_alive(info.pid);
        (info, alive)
    })
    .await
}

/// `acquireAdvisoryLock`, once the lock file is known.
async fn acquire(ctx: &ToolContext, target: &Path, lock_file: &Path, timeout: Duration, poll: Duration) -> Result<String, ToolError> {
    let token = format!("{}.{}", std::process::id(), &uuid::Uuid::new_v4().simple().to_string()[..16]);
    let deadline = Instant::now() + timeout;
    let mut stale_retry_used = false;
    loop {
        let (file, mine) = (lock_file.to_path_buf(), token.clone());
        let created = on_lane(ctx, move || try_create_lock(&file, &mine)).await?;
        if created.map_err(|e| failure(&e, "open", lock_file))? {
            return Ok(token);
        }
        let (holder, alive) = read_info(ctx, lock_file).await?;
        if alive {
            if Instant::now() >= deadline {
                return Err(timeout_error(target, lock_file, holder.pid));
            }
            pause(ctx, poll).await?;
            continue;
        }
        // Under load a live holder can probe dead once: only two agreeing reads reclaim the lock.
        pause(ctx, Duration::from_millis(50)).await?;
        let (second, second_alive) = read_info(ctx, lock_file).await?;
        if second.pid != holder.pid || second.token != holder.token {
            if Instant::now() >= deadline {
                return Err(timeout_error(target, lock_file, if second.pid != 0 { second.pid } else { holder.pid }));
            }
            continue;
        }
        if !second_alive {
            let (file, expected) = (lock_file.to_path_buf(), holder.token.clone());
            on_lane(ctx, move || unlink_if_owned(&file, &expected)).await?;
            pause(ctx, Duration::from_millis(1 + u64::from(std::process::id()) % 5)).await?;
            if Instant::now() < deadline {
                continue;
            }
            if !stale_retry_used {
                stale_retry_used = true;
                continue;
            }
            return Err(timeout_error(target, lock_file, holder.pid));
        }
        if Instant::now() >= deadline {
            return Err(timeout_error(target, lock_file, holder.pid));
        }
        pause(ctx, poll).await?;
    }
}

/// `withAdvisoryLocks` over `paths`: each distinct path once, in code-point order of its key.
/// Two paths of one real file share a lock file, which is taken once.
pub(super) async fn lock_in(ctx: &ToolContext, dir: &Path, paths: &[&Path], timeout: Duration, poll: Duration) -> Result<Advisory, ToolError> {
    let fold = |p: &Path| {
        let text = p.to_string_lossy().into_owned();
        if cfg!(windows) { text.to_lowercase() } else { text }
    };
    let mut ordered: Vec<(String, &Path)> = Vec::new();
    for path in paths {
        let key = fold(path);
        if !ordered.iter().any(|(k, _)| *k == key) {
            ordered.push((key, path));
        }
    }
    ordered.sort_by(|a, b| a.0.cmp(&b.0));
    let mut guard = Advisory { held: Vec::new() };
    for (_, target) in ordered {
        let (root, owned) = (dir.to_path_buf(), target.to_path_buf());
        let prepared = on_lane(ctx, move || ensure_private_dir(&root).map(|()| lock_file_for(&root, &owned))).await?;
        let lock_file = prepared.map_err(|e| failure(&e, "mkdir", dir))?;
        if guard.held.iter().any(|(file, _)| *file == lock_file) {
            continue;
        }
        let token = acquire(ctx, target, &lock_file, timeout, poll).await?;
        guard.held.push((lock_file, token));
    }
    Ok(guard)
}

pub(super) async fn lock(ctx: &ToolContext, paths: &[&Path]) -> Result<Advisory, ToolError> {
    lock_in(ctx, &lock_directory(), paths, TIMEOUT, POLL).await
}