//! Shell environment snapshot (`tools/shell-snapshot.mjs`). Captures the user's interactive shell
//! state (functions, aliases, shell options) by sourcing their rc file in a one-shot login shell
//! and dumping it to a script; later commands `source` it so they run with the same nvm / pyenv /
//! mise / direnv setup the user gets in a terminal, without a login-shell start per call. bash
//! and zsh on POSIX hosts only. The login shell runs through the process manager; every file
//! operation is a lane job.
#![allow(
    clippy::disallowed_methods,
    reason = "lane job bodies are the sanctioned home of blocking file I/O (clippy.toml)"
)]

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_protocol::ProcessHandle;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use mixdog_rt::SpawnIo;
use tokio_util::sync::CancellationToken;

use super::env::is_scrubbed;
use super::invocation::config_file;
use super::invocation::snapshot_has_payload;
use super::invocation::snapshot_script;

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
/// Snapshots older than this belong to a dead instance.
const SNAPSHOT_STALE_MS: u128 = 60 * 60 * 1000;

#[derive(Default)]
pub struct Snapshots {
    cache: Mutex<HashMap<String, PathBuf>>,
    /// Shells whose snapshot failed: later calls fall through at once instead of paying another
    /// 10 s timeout each.
    failed: Mutex<HashSet<String>>,
    swept: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the rc file looks like now; part of the cache key, so editing it mid-session forces a
/// fresh snapshot.
fn rc_state(path: &Path) -> (bool, u128, u64) {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis());
            (true, mtime, meta.len())
        }
        Err(_) => (false, 0, 0),
    }
}

fn sweep_stale(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("snapshot-") || !name.ends_with(".sh") {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age.as_millis() > SNAPSHOT_STALE_MS);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The login shell's environment: loader / secret / host variables scrubbed (it sources the
/// user's rc file, which can exfiltrate whatever it inherits), prompts blank so an interactive
/// sourcing prints no PS1 noise.
fn snapshot_env(shell_path: &str) -> EnvSpec {
    let remove = std::env::vars_os()
        .filter_map(|(k, _)| k.into_string().ok())
        .filter(|name| is_scrubbed(name))
        .collect();
    let set = [
        ("SHELL", shell_path),
        ("GIT_EDITOR", "true"),
        ("CLAUDECODE", "1"),
        ("PS1", ""),
        ("PS2", ""),
        ("PS3", ""),
        ("PS4", ""),
        ("PROMPT", ""),
        ("RPROMPT", ""),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    EnvSpec { inherit: true, set, remove }
}

/// Where a snapshot is requested from.
pub struct SnapshotRequest<'a> {
    pub processes: &'a Arc<dyn ProcessManager>,
    /// A call's start: the rc-file probe and the snapshot's files.
    pub lane: SpawnIo,
    pub cancel: &'a CancellationToken,
    pub shell_path: &'a str,
    pub data_dir: &'a Path,
    pub launcher_dir: &'a str,
    pub cwd: AbsPath,
    pub thread: ThreadId,
    pub call: ToolCallId,
}

impl Snapshots {
    /// The snapshot file for the shell, generating it on first use; `None` when generation failed
    /// (the command then runs without the snapshot prelude).
    pub async fn get(&self, request: SnapshotRequest<'_>) -> Option<PathBuf> {
        let home = dirs::home_dir()?.to_string_lossy().into_owned();
        let config = PathBuf::from(config_file(request.shell_path, &home));
        let dir = request.data_dir.join("shell-snapshots");
        let sweep = !self.swept.swap(true, Ordering::AcqRel);
        let (sweep_dir, config_probe) = (dir.clone(), config.clone());
        let probe = request
            .lane
            .submit(request.cancel, move |_| {
                if sweep {
                    sweep_stale(&sweep_dir);
                }
                rc_state(&config_probe)
            })
            .ok()?
            .await
            .ok()?;
        let (config_exists, mtime, size) = probe;
        let key = format!("{}|{mtime}|{size}", request.shell_path);
        if lock(&self.failed).contains(&key) {
            return None;
        }
        let cached = lock(&self.cache).get(&key).cloned();
        if let Some(path) = cached {
            let probe = path.clone();
            let present = request.lane.submit(request.cancel, move |_| probe.exists()).ok()?.await.ok()?;
            if present {
                return Some(path);
            }
        }
        let lower = request.shell_path.to_lowercase();
        let tag = if lower.contains("zsh") {
            "zsh"
        } else if lower.contains("bash") {
            "bash"
        } else {
            "sh"
        };
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let suffix = {
            use sha2::Digest;
            let digest = sha2::Sha256::digest(format!("{stamp}:{}", std::process::id()));
            digest.iter().take(3).map(|b| format!("{b:02x}")).collect::<String>()
        };
        let path = dir.join(format!("snapshot-{tag}-{stamp}-{suffix}.sh"));
        let made = path.clone();
        let make_dir = dir.clone();
        let _ = request
            .lane
            .submit(request.cancel, move |_| {
                let _ = std::fs::create_dir_all(&make_dir);
                made
            })
            .ok()?
            .await;
        let result = self.run(&request, &path, config_exists.then(|| config.to_string_lossy().into_owned())).await;
        match &result {
            Some(path) => {
                lock(&self.cache).insert(key, path.clone());
            }
            None => {
                lock(&self.failed).insert(key);
            }
        }
        result
    }

    /// Runs the dump script in a login shell (`-c -l`: login mode runs the profile without
    /// bash-completion's `find` subshells, which leak on a timeout kill).
    async fn run(&self, request: &SnapshotRequest<'_>, path: &Path, config: Option<String>) -> Option<PathBuf> {
        let script = snapshot_script(request.shell_path, &path.to_string_lossy(), config.as_deref(), request.launcher_dir);
        let handle = ProcessHandle(format!("snapshot-{}", request.call));
        let spawn = SpawnRequest {
            handle: handle.clone(),
            command: CommandSpec::Argv {
                program: request.shell_path.to_owned(),
                args: vec!["-c".into(), "-l".into(), script],
            },
            cwd: request.cwd.clone(),
            env: snapshot_env(request.shell_path),
            pty: None,
            stdin_piped: false,
            output: OutputMode::Separate,
            owner: ProcessOwner::Tool { thread_id: request.thread.clone(), tool_call_id: request.call.clone() },
            time_limit: Some(SNAPSHOT_TIMEOUT),
        };
        let mut finished_ok = false;
        if request.processes.spawn(spawn).await.is_ok() {
            if let Ok(mut source) = request.processes.subscribe(&handle, Some(0)) {
                while let Some(event) = source.next().await {
                    if let ProcessEvent::Exited { exit, .. } = event {
                        finished_ok = exit.killed.is_none() && exit.status == ExitStatus::Code(0);
                        break;
                    }
                }
            }
        }
        let target = path.to_owned();
        request
            .lane
            .submit(request.cancel, move |_| {
                let keep = finished_ok
                    && std::fs::read_to_string(&target).is_ok_and(|content| snapshot_has_payload(&content));
                if keep {
                    Some(target)
                } else {
                    // A failure may leave a partly written file behind; an empty snapshot is rejected.
                    let _ = std::fs::remove_file(&target);
                    None
                }
            })
            .ok()?
            .await
            .ok()?
    }

    /// Removes every snapshot this runtime made; the host calls it at graceful shutdown
    /// (`drainShellSnapshots`, Node's process-exit hook).
    pub async fn drain(&self, lane: MaintenanceIo, cancel: &CancellationToken) {
        let files: Vec<PathBuf> = std::mem::take(&mut *lock(&self.cache)).into_values().collect();
        if let Ok(job) = lane.submit(cancel, move |_| {
            for file in files {
                let _ = std::fs::remove_file(file);
            }
        }) {
            let _ = job.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn drain_removes_every_snapshot_file_the_runtime_made() {
        let dir = tempfile::tempdir().unwrap();
        let snapshots = Snapshots::default();
        let file = dir.path().join("snapshot-bash-1-abc.sh");
        std::fs::write(&file, "alias ll='ls -l'").unwrap();
        lock(&snapshots.cache).insert("bash|1|1".into(), file.clone());
        snapshots.drain(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new()).await;
        assert!(!file.exists());
        assert!(lock(&snapshots.cache).is_empty());
    }
}
