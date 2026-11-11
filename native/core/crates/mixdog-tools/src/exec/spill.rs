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

/// Creates (truncating) both logs of a job and their directory. Best effort.
pub async fn create_logs(lane: MaintenanceIo, cancel: &CancellationToken, out: &Path, err: &Path) {
    let (out, err): (PathBuf, PathBuf) = (out.to_owned(), err.to_owned());
    let Ok(handle) = lane.submit(cancel, move |_| {
        if let Some(dir) = out.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::File::create(&out)?;
        std::fs::File::create(&err).map(drop)
    }) else {
        return;
    };
    let _ = handle.await;
}

/// How long a job's logs are kept (`SHELL_OUTPUT_RETENTION_MS`): transcripts keep naming them, so
/// a session resumed days later may still read them.
pub const RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Whether `name` is one of the logs a job writes (`<task id>.stdout.log`, `<task id>.stderr.log`, the task id
/// `task-<call id>`): nothing else in the directory is the sweep's.
fn is_job_log(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .is_some_and(|name| name.starts_with("task-") && (name.ends_with(".stdout.log") || name.ends_with(".stderr.log")))
}

/// Removes the job logs of `dir` last modified more than `RETENTION_MS` ago, by the system clock the
/// modification times are written with (`sweepExpiredShellOutput`). Best effort: a file that
/// cannot be read or removed stays. It runs before any job of this runtime is older than the retention, so
/// no log one of them writes is old enough; a job of another process whose log has had nothing written for
/// the retention keeps spilling, into a log its next append recreates ([`append`]).
pub async fn sweep_expired(lane: MaintenanceIo, cancel: &CancellationToken, dir: &Path) {
    #[cfg(test)]
    sweep_gate::pass(dir).await;
    let dir = dir.to_owned();
    let Ok(handle) = lane.submit(cancel, move |_| {
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_millis(RETENTION_MS);
        for entry in std::fs::read_dir(&dir)?.flatten() {
            if !is_job_log(&entry.file_name()) {
                continue;
            }
            if entry.metadata().and_then(|m| m.modified()).is_ok_and(|modified| modified < cutoff) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        Ok::<(), std::io::Error>(())
    }) else {
        return;
    };
    let _ = handle.await;
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

/// Appends `bytes` to `path`, recreating a log another process's sweep removed. `false` when the log
/// cannot be written, after which the caller stops spilling that stream.
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
