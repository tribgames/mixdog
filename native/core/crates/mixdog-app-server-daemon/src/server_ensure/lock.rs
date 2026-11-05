//! The server-wide install lock, in the 1.4.5 installer's directory protocol so old and new
//! installers exclude each other (LR §8.1: "the one install lock").
//!
//! Layout: the holder creates `lockDir` (atomic `mkdir`), then its own token directory
//! `lockDir/<24 hex>/` holding `owner.json`. A lock is stale when its owner is a dead pid on
//! this host or is older than `stale`. A stealer deletes exactly the token directory it judged
//! stale and `rmdir`s `lockDir`, which refuses a directory a new holder has entered. Token
//! directories are deleted in place, never renamed.

use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::UNIX_EPOCH;

use serde::Deserialize;
use serde::Serialize;

use super::error::EnsureError;
use super::host::EnsureHost;

const TOKEN_LEN: usize = 24;
/// A lock directory or token directory without its `owner.json` is being written this
/// instant or was abandoned mid-creation; past this age it is abandoned.
const ABANDONED_AFTER_MS: u64 = 30_000;
const POLL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone)]
pub struct LockOptions {
    /// How long to wait for another holder before `install-locked`.
    pub wait: Duration,
    /// A holder older than this is presumed crashed even if its pid looks alive.
    pub stale: Duration,
    pub purpose: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Owner {
    token: String,
    pid: u32,
    host: String,
    #[serde(default)]
    purpose: String,
    started_at: u64,
}

pub struct InstallLock {
    lock_dir: PathBuf,
    token: String,
}

enum Removal {
    Removed,
    Gone,
    Busy,
}

struct Holder {
    gone: bool,
    stale: bool,
    token: Option<String>,
    owner: Option<Owner>,
}

fn token_dir_names(lock_dir: &Path) -> Option<Vec<String>> {
    let entries = match fs::read_dir(lock_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => return Some(Vec::new()),
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| {
            name.len() == TOKEN_LEN && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
        .collect();
    names.sort();
    Some(names)
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(since.as_millis()).ok()
}

fn contended(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::AlreadyExists
        // A directory being deleted on Windows refuses `mkdir` with a permission error.
        || (cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied)
}

fn inspect(lock_dir: &Path, stale: Duration, host: &dyn EnsureHost) -> Holder {
    let gone = Holder { gone: true, stale: false, token: None, owner: None };
    let Some(holders) = token_dir_names(lock_dir) else { return gone };
    let now = host.now_ms();
    let Some(token) = holders.into_iter().next() else {
        let Some(since) = mtime_ms(lock_dir) else { return gone };
        return Holder {
            gone: false,
            stale: now.saturating_sub(since) > ABANDONED_AFTER_MS,
            token: None,
            owner: None,
        };
    };
    let token_dir = lock_dir.join(&token);
    let Some(dir_since) = mtime_ms(&token_dir) else {
        return Holder { gone: false, stale: false, token: None, owner: None };
    };
    let owner: Option<Owner> = fs::read(token_dir.join("owner.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let since = owner.as_ref().map_or(dir_since, |o| if o.started_at > 0 { o.started_at } else { dir_since });
    let age = now.saturating_sub(since);
    let stale_now = match &owner {
        None => age > ABANDONED_AFTER_MS,
        Some(o) => {
            let dead = o.host == host.hostname() && !host.process_alive(o.pid);
            dead || age > u64::try_from(stale.as_millis()).unwrap_or(u64::MAX)
        }
    };
    Holder { gone: false, stale: stale_now, token: Some(token), owner }
}

fn remove_token(lock_dir: &Path, token: &str, retries: u32, pause: &dyn Fn(Duration)) -> Removal {
    let dir = lock_dir.join(token);
    for attempt in 0.. {
        let result = fs::remove_file(dir.join("owner.json"))
            .or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) })
            .and_then(|()| fs::remove_dir(&dir));
        match result {
            Ok(()) => return Removal::Removed,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Removal::Gone,
            Err(_) if attempt >= retries => return Removal::Busy,
            Err(_) => pause(Duration::from_millis(20)),
        }
    }
    Removal::Busy
}

/// `rmdir` of an empty lock directory: one a holder has entered is never removed.
fn drop_empty(lock_dir: &Path, retries: u32, pause: &dyn Fn(Duration)) -> Removal {
    for attempt in 0.. {
        match fs::remove_dir(lock_dir) {
            Ok(()) => return Removal::Removed,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Removal::Gone,
            // Not empty: a holder has entered.
            Err(_) if !token_dir_names(lock_dir).is_none_or(|names| names.is_empty()) => {
                return Removal::Gone;
            }
            Err(_) if attempt >= retries => return Removal::Busy,
            Err(_) => pause(Duration::from_millis(20)),
        }
    }
    Removal::Busy
}

fn steal(lock_dir: &Path, holder: &Holder, pause: &dyn Fn(Duration)) -> bool {
    let removed = match &holder.token {
        Some(token) => match remove_token(lock_dir, token, 0, pause) {
            Removal::Removed => true,
            Removal::Gone => false,
            Removal::Busy => return false,
        },
        None => false,
    };
    matches!(drop_empty(lock_dir, 0, pause), Removal::Removed) || removed
}

fn describe(owner: Option<&Owner>) -> String {
    let Some(owner) = owner else { return "owner unknown".to_owned() };
    let mut parts = vec![format!("pid {} on {}", owner.pid, owner.host)];
    if !owner.purpose.is_empty() {
        parts.push(owner.purpose.clone());
    }
    if owner.started_at > 0 {
        parts.push(format!("since {}", owner.started_at));
    }
    parts.join(", ")
}

impl InstallLock {
    pub fn acquire(
        lock_dir: &Path,
        options: &LockOptions,
        host: &dyn EnsureHost,
    ) -> Result<Self, EnsureError> {
        let failed = |error: std::io::Error| {
            EnsureError::InstallFailed(format!(
                "Cannot create the install lock {}: {error}",
                lock_dir.display()
            ))
        };
        let token = crate::lifecycle::hex(&rand::random::<[u8; TOKEN_LEN / 2]>());
        let mine = lock_dir.join(&token);
        let pause = |duration| host.pause(duration);
        let began = host.now_ms();
        if let Some(parent) = lock_dir.parent() {
            fs::create_dir_all(parent).map_err(failed)?;
        }
        loop {
            match fs::create_dir(lock_dir) {
                Ok(()) => {
                    match fs::create_dir(&mine) {
                        Ok(()) => {
                            let owner = Owner {
                                token: token.clone(),
                                pid: std::process::id(),
                                host: host.hostname(),
                                purpose: options.purpose.clone(),
                                started_at: host.now_ms(),
                            };
                            let body = serde_json::to_vec(&owner).map_err(std::io::Error::other).map_err(failed)?;
                            fs::write(mine.join("owner.json"), body).map_err(failed)?;
                            if token_dir_names(lock_dir).as_deref() == Some(std::slice::from_ref(&token)) {
                                return Ok(Self { lock_dir: lock_dir.to_owned(), token });
                            }
                            // Another holder entered while this creator stalled: the later one
                            // backs off.
                            if matches!(remove_token(lock_dir, &token, 5, &pause), Removal::Removed) {
                                drop_empty(lock_dir, 5, &pause);
                            }
                        }
                        // `lockDir` went away (judged abandoned while this creator stalled).
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound || contended(&error) => {}
                        Err(error) => return Err(failed(error)),
                    }
                    host.pause(Duration::from_millis(20 + u64::from(rand::random::<u8>() % 30)));
                    continue;
                }
                Err(error) if contended(&error) => {}
                Err(error) => return Err(failed(error)),
            }
            let holder = inspect(lock_dir, options.stale, host);
            if holder.gone {
                continue;
            }
            if holder.stale && steal(lock_dir, &holder, &pause) {
                continue;
            }
            let waited = host.now_ms().saturating_sub(began);
            if waited >= u64::try_from(options.wait.as_millis()).unwrap_or(u64::MAX) {
                return Err(EnsureError::InstallLocked {
                    lock: lock_dir.display().to_string(),
                    owner: describe(holder.owner.as_ref()),
                });
            }
            host.pause(POLL);
        }
    }
}

impl Drop for InstallLock {
    fn drop(&mut self) {
        let pause = |duration| std::thread::sleep(duration);
        // `Gone` means the lock was taken over as stale: the root is no longer ours to drop.
        if matches!(remove_token(&self.lock_dir, &self.token, 250, &pause), Removal::Removed) {
            drop_empty(&self.lock_dir, 250, &pause);
        }
    }
}