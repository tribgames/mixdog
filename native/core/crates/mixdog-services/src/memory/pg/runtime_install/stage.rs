//! The runtime directory's layout and its housekeeping (`runtime-fetcher.mjs`): the
//! `active-version` pointer, `runtime-<key>` trees stamped with the asset digest, and the
//! `staging-*` downloads guarded by cross-process lock files. Everything here is the body of a
//! lane job (`job` in the parent module). The functions that publish take the job's
//! [`InLane`] proof: `mixdog-statefile` writes the stamp and the pointer atomically and renames
//! with Node's backoff (25, 50, 100 ms, then 200 ms, up to 24 attempts, sleeping on the lane
//! thread as Node's synchronous call does).
//!
//! A staging lock is an `O_EXCL` file `<staging>.lock` stamped `<pid> <ms>` and held open for the
//! whole download, extract and publish. The GC of any sibling leaves a staging directory alone
//! while its lock names a live pid and is younger than [`STAGING_LOCK_STALE_MS`].

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "lane-job bodies: the parent module runs them as jobs")]

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use mixdog_js::{is_js_space, js_trim};
use mixdog_rt::{DurabilityIo, InLane};
use mixdog_statefile::{Access, Opts, StateError, create_new, process_exists, rename_with_retry, write_file};

/// A lock older than this is abandoned, whoever its pid is (`STAGING_LOCK_STALE_MS`).
pub const STAGING_LOCK_STALE_MS: f64 = 600_000.0;

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() }
}

/// `readActiveVersion`: the `active-version` pointer, trimmed.
pub fn read_active_version(base: &Path) -> Option<String> {
    fs::read_to_string(base.join("active-version")).ok().map(|text| js_trim(&text).to_owned())
}

/// `runtimeInstallKey`: a rebuilt asset of one version gets its own directory.
pub fn install_key(version: &str, sha256: &str) -> String {
    format!("{version}-{}", sha256.chars().take(12).collect::<String>())
}

/// `runtimeVerDir`.
pub fn ver_dir(base: &Path, key: &str) -> PathBuf {
    base.join(format!("runtime-{key}"))
}

/// `runtimeDirInUse`: a running executable cannot be opened for writing (a sharing violation on
/// Windows, `ETXTBSY` on Linux, `EBUSY`).
fn dir_in_use(dir: &Path) -> bool {
    let postgres = dir.join("bin").join(exe("postgres"));
    match fs::OpenOptions::new().read(true).write(true).open(postgres) {
        Ok(_) => false,
        Err(error) => match error.raw_os_error() {
            #[cfg(windows)]
            Some(code) => code == 32 || code == 170, // ERROR_SHARING_VIOLATION, ERROR_BUSY
            #[cfg(not(windows))]
            Some(code) => code == 26 || code == 16, // ETXTBSY, EBUSY
            None => false,
        },
    }
}

/// `discardRuntimeDir`: moves the tree aside whole, then removes it. A tree a PostgreSQL runs
/// from is left intact and the call fails.
fn discard_runtime_dir(base: &Path, dir: &Path, now_ms: i64) -> io::Result<()> {
    if dir_in_use(dir) {
        return Err(io::Error::other(format!("[runtime-fetcher] runtime dir is in use: {}", dir.display())));
    }
    let trash = base.join(format!("staging-discard-{now_ms}-{}-{}", std::process::id(), random_tag()));
    fs::rename(dir, &trash)?;
    remove_any(&trash);
    Ok(())
}

/// `rmSync(path, { recursive: true, force: true })`.
pub fn remove_any(path: &Path) {
    let _ = if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) };
}

/// Six base-36 characters, as `Math.random().toString(36).slice(2, 8)`.
pub fn random_tag() -> String {
    const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    uuid::Uuid::new_v4().as_bytes()[..6].iter().map(|byte| char::from(ALPHABET[usize::from(*byte) % 36])).collect()
}

/// `holdsNoData`: nothing but NUL and whitespace.
fn holds_no_data(bytes: &[u8]) -> bool {
    bytes.iter().all(|byte| matches!(byte, 0 | b' ' | b'\t' | b'\n' | b'\r'))
}

/// `fileHasData`: false when the file is absent or its first 4096 bytes hold no data; a file
/// that exists but cannot be read right now still counts as present.
fn file_has_data(path: &Path) -> bool {
    use std::io::Read;
    let mut head = vec![0u8; 4096];
    match fs::File::open(path).and_then(|mut file| file.read(&mut head)) {
        Ok(read) => !holds_no_data(&head[..read]),
        Err(error) => !matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory),
    }
}

/// `readRuntimeStamp`: the digest stamped into a complete tree, empty when absent or when the
/// tree's `postgres` holds no data.
pub fn read_runtime_stamp(ver_dir: &Path) -> String {
    let postgres = ver_dir.join("bin").join(exe("postgres"));
    if postgres.exists() && !file_has_data(&postgres) {
        return String::new();
    }
    fs::read_to_string(ver_dir.join(".version-sha256")).map(|text| js_trim(&text).to_owned()).unwrap_or_default()
}

/// `cachedRuntimeDir`: the reusable tree when `active-version` names this version (keyed or
/// bare) and the tree carries the expected digest.
pub fn cached_runtime_dir(base: &Path, version: &str, sha256: &str) -> Option<PathBuf> {
    let key = read_active_version(base)?;
    if key != version && key != install_key(version, sha256) {
        return None;
    }
    let dir = ver_dir(base, &key);
    (read_runtime_stamp(&dir) == sha256).then_some(dir)
}

/// `writeFileAtomicSync(path, bytes, { fsyncDir })`: a synced temp file renamed into place,
/// with the rename retried on Node's schedule.
pub fn write_atomic(proof: &InLane<DurabilityIo>, path: &Path, bytes: &[u8], fsync_dir: bool) -> io::Result<()> {
    write_file(proof, path, bytes, &Opts { fsync_dir, ..Opts::default() }).map(drop).map_err(|error| match error {
        StateError::Io(error) => error,
        other => io::Error::other(other.to_string()),
    })
}

/// `normalizeBinExecBit`: `bin/*` is executable (no-op on Windows).
pub fn normalize_bin_exec_bit(ver_dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let Ok(entries) = fs::read_dir(ver_dir.join("bin")) else { return };
        for entry in entries.flatten() {
            let _ = fs::set_permissions(entry.path(), fs::Permissions::from_mode(0o755));
        }
    }
    #[cfg(not(unix))]
    let _ = ver_dir;
}

/// `publishRuntimeDir`: the staged tree becomes `runtime-<key>` and `active-version` points at
/// it. A sibling that raced this install may already have published the same asset: that tree is
/// kept (it may be running) and this copy dropped. Any other `runtime-<key>` is an interrupted
/// install of this asset; it is moved aside whole, and one in use fails the publish intact.
pub fn publish(proof: &InLane<DurabilityIo>, base: &Path, staging: &Path, key: &str, sha256: &str, now_ms: i64) -> io::Result<()> {
    let dir = ver_dir(base, key);
    if read_runtime_stamp(&dir) == sha256 {
        remove_any(staging);
    } else {
        if dir.exists() {
            discard_runtime_dir(base, &dir, now_ms)?;
        }
        rename_with_retry(proof, staging, &dir)?;
    }
    write_atomic(proof, &base.join("active-version"), key.as_bytes(), true)
}

// ── staging locks ────────────────────────────────────────────────────────

/// `<staging>.lock`.
pub fn lock_path(staging: &Path) -> PathBuf {
    let mut name = staging.as_os_str().to_owned();
    name.push(".lock");
    PathBuf::from(name)
}

/// `_readStagingLockPid`: `parseInt` of the first whitespace-separated token; a positive number
/// or nothing.
fn read_lock_pid(lock: &Path) -> Option<u64> {
    let text = fs::read_to_string(lock).ok()?;
    let token: &str = js_trim(&text).split(is_js_space).next().unwrap_or("");
    let digits = token.strip_prefix('+').unwrap_or(token);
    let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
    digits.parse::<u64>().ok().filter(|pid| *pid > 0)
}

/// `_stagingLockPidAlive`: this process is alive; a pid that cannot be signalled for another
/// reason than not existing is alive too, so a live holder is never robbed.
fn pid_alive(pid: Option<u64>) -> bool {
    match pid {
        None => false,
        Some(pid) if pid == u64::from(std::process::id()) => true,
        Some(pid) => u32::try_from(pid).map_or(true, process_exists),
    }
}

/// `_stagingLockIsLive`: the lock exists, names a live owner (or has no readable pid) and is not
/// older than the stale budget.
pub fn lock_is_live(lock: &Path, now_ms: i64) -> bool {
    let Ok(meta) = fs::metadata(lock) else { return false };
    let pid = read_lock_pid(lock);
    if pid.is_some() && !pid_alive(pid) {
        return false;
    }
    let modified_ms = meta.modified().ok().and_then(|at| at.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    now_ms as f64 - modified_ms <= STAGING_LOCK_STALE_MS
}

/// A staging lock this process holds: its file stays open until [`release_lock`].
pub struct StagingLock {
    file: fs::File,
    path: PathBuf,
}

/// `acquireStagingLock`: `O_EXCL`, so it fails when a sibling already owns the lock.
pub fn acquire_lock(proof: &InLane<DurabilityIo>, staging: &Path, now_ms: i64) -> io::Result<StagingLock> {
    let path = lock_path(staging);
    let mut file = create_new(proof, &path, Access::Inherit, 0o666)?;
    let _ = file.write_all(format!("{} {now_ms}\n", std::process::id()).as_bytes());
    Ok(StagingLock { file, path })
}

/// `releaseStagingLock`: closes the file; unlinks it only while the stamp is still ours, so a
/// stolen and replaced lock is not destroyed under its new owner.
pub fn release_lock(lock: StagingLock) {
    let StagingLock { file, path } = lock;
    drop(file);
    if read_lock_pid(&path) == Some(u64::from(std::process::id())) {
        let _ = fs::remove_file(&path);
    }
}

/// `gcRuntimeDir`: reaps `staging-*` that no live lock guards and `runtime-*` that is not
/// `keep`, moving a tree aside whole first. Without a kept version `keep` spells `null`, as in
/// Node, which keeps nothing.
pub fn gc(base: &Path, keep: Option<&str>, now_ms: i64) {
    let Ok(read) = fs::read_dir(base) else { return };
    let names: Vec<String> = read.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    let kept = format!("runtime-{}", keep.unwrap_or("null"));
    for name in &names {
        if name.starts_with("staging-") {
            if let Some(owner) = name.strip_suffix(".lock") {
                // An orphan lock file (its staging directory is gone) is reaped when provably dead.
                if names.iter().any(|other| other == owner) || lock_is_live(&base.join(name), now_ms) {
                    continue;
                }
                let _ = fs::remove_file(base.join(name));
                continue;
            }
            // A download `staging-<tag>.tar.gz` is guarded by its staging directory's lock.
            let guard = name.strip_suffix(".tar.gz").unwrap_or(name);
            let lock = lock_path(&base.join(guard));
            if lock_is_live(&lock, now_ms) {
                continue;
            }
            remove_any(&base.join(name));
            let _ = fs::remove_file(&lock);
        } else if name.starts_with("runtime-") && *name != kept {
            let path = base.join(name);
            if path.is_dir() {
                let _ = discard_runtime_dir(base, &path, now_ms);
            } else {
                let _ = fs::remove_file(&path);
            }
        }
    }
}
