//! Output log files of shell jobs. Every filesystem call runs as a job on a maintenance-lane
//! token, never on an async worker.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "lane job bodies are the sanctioned home of blocking file I/O (clippy.toml)"
)]

use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use tokio_util::sync::CancellationToken;

const STDOUT_SUFFIX: &str = ".stdout.log";
const STDERR_SUFFIX: &str = ".stderr.log";
/// The ownership record of a job's logs, `<task id>.owner.json` beside them: who wrote them and whether that job has
/// ended. It is the only thing the sweep goes by, so it is readable by every process sharing the folder.
const OWNER_SUFFIX: &str = ".owner.json";

/// The ownership record of the logs whose stdout log is `out`.
fn owner_path(out: &Path) -> Option<PathBuf> {
    let name = out.file_name()?.to_str()?.strip_suffix(STDOUT_SUFFIX)?;
    Some(out.with_file_name(format!("{name}{OWNER_SUFFIX}")))
}

fn owner_record(state: &str) -> Vec<u8> {
    serde_json::json!({"pid": std::process::id(), "state": state}).to_string().into_bytes()
}

/// Creates (truncating) both logs of a job and their directory, after their ownership record (the job is running), so
/// no sweep ever finds one of them without it. Best effort.
pub async fn create_logs(lane: MaintenanceIo, cancel: &CancellationToken, out: &Path, err: &Path) {
    let (out, err): (PathBuf, PathBuf) = (out.to_owned(), err.to_owned());
    let Ok(handle) = lane.submit(cancel, move |_| {
        if let Some(dir) = out.parent() {
            std::fs::create_dir_all(dir)?;
        }
        if let Some(owner) = owner_path(&out) {
            std::fs::write(owner, owner_record("running"))?;
        }
        std::fs::File::create(&out)?;
        std::fs::File::create(&err).map(drop)
    }) else {
        return;
    };
    let _ = handle.await;
}

/// Records that the job whose stdout log is `out` has ended: nothing writes its logs any more, so the sweep may take
/// them once they have aged. A job whose logs were never created has no record and gets none.
pub async fn mark_finished(lane: MaintenanceIo, cancel: &CancellationToken, out: &Path) {
    let Some(owner) = owner_path(out) else { return };
    let Ok(handle) = lane.submit(cancel, move |_| {
        if std::fs::exists(&owner)? {
            std::fs::write(&owner, owner_record("finished"))?;
        }
        Ok::<(), std::io::Error>(())
    }) else {
        return;
    };
    let _ = handle.await;
}

/// How long a job's logs are kept (`SHELL_OUTPUT_RETENTION_MS`): transcripts keep naming them, so
/// a session resumed days later may still read them.
pub const RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Removes the logs of the jobs of `dir` that their ownership record shows ended, when the record and both logs were
/// last modified more than `RETENTION_MS` ago, by the system clock the modification times are written with
/// (`sweepExpiredShellOutput`). A running job's logs, this process's or another's, are never taken, however long they
/// have been silent; a file named like a log that has no ownership record (a user's, an older version's) stays, and
/// is counted in a log line. Returns that count. Best effort: a file that cannot be read or removed stays.
pub async fn sweep_expired(lane: MaintenanceIo, cancel: &CancellationToken, dir: &Path) -> usize {
    #[cfg(test)]
    sweep_gate::pass(dir).await;
    let dir = dir.to_owned();
    let Ok(handle) = lane.submit(cancel, move |_| {
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_millis(RETENTION_MS);
        let aged = |path: &Path| match std::fs::metadata(path).and_then(|m| m.modified()) {
            Ok(modified) => modified < cutoff,
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        };
        let names: Vec<String> = std::fs::read_dir(&dir)?.flatten().filter_map(|e| e.file_name().into_string().ok()).collect();
        let mut unowned = 0;
        for name in &names {
            let id = [STDOUT_SUFFIX, STDERR_SUFFIX].iter().find_map(|suffix| name.strip_suffix(suffix));
            if id.is_some_and(|id| !names.iter().any(|other| other.strip_suffix(OWNER_SUFFIX) == Some(id))) {
                unowned += 1;
            }
            let Some(id) = name.strip_suffix(OWNER_SUFFIX) else { continue };
            let owner = dir.join(name);
            let finished = std::fs::read(&owner)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .is_some_and(|record| record["state"] == "finished");
            let logs = [dir.join(format!("{id}{STDOUT_SUFFIX}")), dir.join(format!("{id}{STDERR_SUFFIX}"))];
            if finished && aged(&owner) && logs.iter().all(|log| aged(log)) {
                for log in &logs {
                    let _ = std::fs::remove_file(log);
                }
                let _ = std::fs::remove_file(&owner);
            }
        }
        if unowned > 0 {
            tracing::info!(dir = %dir.display(), unowned, "shell log sweep left files named like job logs that have no ownership record");
        }
        Ok::<usize, std::io::Error>(unowned)
    }) else {
        return 0;
    };
    handle.await.ok().and_then(Result::ok).unwrap_or(0)
}

/// Holds the log sweep of one directory until released, so a test can show the command does not wait for it.
#[cfg(test)]
pub(crate) mod sweep_gate {
    use std::path::Path;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::Mutex;

    use tokio::sync::Notify;

    static HELD: Mutex<Option<(PathBuf, Arc<Notify>)>> = Mutex::new(None);

    /// The sweep of `dir` waits at its start until the returned signal is notified.
    pub(crate) fn hold(dir: &Path) -> Arc<Notify> {
        let gate = Arc::new(Notify::new());
        *HELD.lock().unwrap() = Some((dir.to_owned(), Arc::clone(&gate)));
        gate
    }

    pub(super) async fn pass(dir: &Path) {
        let gate = HELD.lock().unwrap().as_ref().filter(|(held, _)| held == dir).map(|(_, gate)| Arc::clone(gate));
        if let Some(gate) = gate {
            gate.notified().await;
        }
    }
}

/// Appends `bytes` to `path`, recreating a log removed under it. `false` when the log cannot be written, after which
/// the caller stops spilling that stream.
pub async fn append(lane: MaintenanceIo, cancel: &CancellationToken, path: &Path, bytes: Vec<u8>) -> bool {
    let path = path.to_owned();
    let Ok(handle) = lane.submit(cancel, move |_| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut file| file.write_all(&bytes))
    }) else {
        return false;
    };
    matches!(handle.await, Ok(Ok(())))
}

static HOIST_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A unique file name `mixdog-inline-<pid>-<uuid-shaped hex><extension>` in the temp directory.
fn hoist_file_name(extension: &str) -> String {
    use sha2::Digest;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let n = HOIST_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let digest = sha2::Sha256::digest(format!("{}:{nanos}:{n}", std::process::id()));
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!(
        "mixdog-inline-{}-{}-{}-{}-{}-{}{extension}",
        std::process::id(),
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Eight hex characters, unique per call (`randomUUID().slice(0, 8)`).
pub fn fresh_token() -> String {
    use sha2::Digest;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let n = HOIST_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let digest = sha2::Sha256::digest(format!("tee:{}:{nanos}:{n}", std::process::id()));
    digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

/// Writes a hoisted script to a new file in the temp directory (the exclusive flag refuses a
/// name that exists). A PowerShell script gets a BOM: Windows PowerShell 5.1 reads UTF-8 without
/// one as the active ANSI code page.
pub async fn write_hoist_file(
    lane: MaintenanceIo,
    cancel: &CancellationToken,
    extension: &'static str,
    body: &str,
) -> Option<PathBuf> {
    let path = std::env::temp_dir().join(hoist_file_name(extension));
    let content = if extension == ".ps1" { format!("\u{feff}{body}") } else { body.to_owned() };
    let target = path.clone();
    let job = lane
        .submit(cancel, move |_| {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .and_then(|mut file| file.write_all(content.as_bytes()))
        })
        .ok()?;
    matches!(job.await, Ok(Ok(()))).then_some(path)
}

/// The tail of a tee spill file (`readFilterTeeCapture`, at most `max_bytes`), BOM-sniffed:
/// Windows PowerShell 5.1 writes UTF-16LE, pwsh 7 UTF-8. `None` when missing, empty or unreadable.
pub async fn read_tee_tail(lane: MaintenanceIo, cancel: &CancellationToken, path: &Path, max_bytes: u64) -> Option<String> {
    use std::io::Read;
    use std::io::Seek;
    let path = path.to_owned();
    let job = lane
        .submit(cancel, move |_| -> Option<String> {
            let mut file = std::fs::File::open(&path).ok()?;
            let size = file.metadata().ok()?.len();
            if size == 0 {
                return None;
            }
            let mut bom = [0u8; 2];
            let read = file.read(&mut bom).ok()?;
            let utf16 = read == 2 && bom == [0xff, 0xfe];
            let mut start = size.saturating_sub(max_bytes);
            if utf16 && start % 2 == 1 {
                start += 1;
            }
            file.seek(std::io::SeekFrom::Start(start)).ok()?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).ok()?;
            super::invocation::decode_tee_capture(&bytes, utf16)
        })
        .ok()?;
    job.await.ok()?
}

/// Writes (atomically) or refreshes the skill launcher files of one installation; best effort.
pub async fn ensure_launcher_dir(
    lane: MaintenanceIo,
    cancel: &CancellationToken,
    dir: &Path,
    files: Vec<(String, String)>,
) {
    let dir = dir.to_owned();
    let Ok(job) = lane.submit(cancel, move |_| -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        for (name, content) in files {
            let file = dir.join(&name);
            if std::fs::read_to_string(&file).is_ok_and(|current| current == content) {
                continue;
            }
            let temp = dir.join(format!("{name}.tmp-{}", std::process::id()));
            std::fs::write(&temp, content.as_bytes())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o700))?;
            }
            std::fs::rename(&temp, &file)?;
        }
        Ok(())
    }) else {
        return;
    };
    let _ = job.await;
}

/// Removes a file; best effort (an unconfirmed kill may keep it locked). Whether it is gone.
pub async fn remove_file(lane: MaintenanceIo, cancel: &CancellationToken, path: &Path) -> bool {
    let path = path.to_owned();
    let Ok(job) = lane.submit(cancel, move |_| std::fs::remove_file(&path)) else {
        return false;
    };
    match job.await {
        Ok(Ok(())) => true,
        Ok(Err(error)) => error.kind() == std::io::ErrorKind::NotFound,
        Err(_) => false,
    }
}

/// Creates a directory (and parents) for a session scratch folder. Best effort.
pub async fn create_dir(lane: MaintenanceIo, cancel: &CancellationToken, dir: &Path) {
    let dir = dir.to_owned();
    if let Ok(handle) = lane.submit(cancel, move |_| std::fs::create_dir_all(&dir)) {
        let _ = handle.await;
    }
}
