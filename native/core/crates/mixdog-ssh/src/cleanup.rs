//! Removes what the desktop installed on a server: stops the Mixdog core there (`mixdogd server-ensure` with mode
//! `cleanup`: only a core proven to run from `~/.mixdog-remote/versions` is stopped, through the control listener's
//! wind-down, never a signal; a core of the user's own install has another runtime root and is never touched) and
//! deletes `~/.mixdog-remote`, keeping `user-data` unless asked otherwise. The removal stops, proves nothing else
//! runs from the install, and deletes inside one hold of the server-wide install lock. The server's runtime does all
//! of it, so cleaning a server that holds none of this desktop's build uploads it first.

use std::time::Duration;

use serde_json::Value;

use crate::bootstrap::{base_args, Remote, ServerPayloads, REMOTE_PROBE_TIMEOUT};
use crate::command::SshTarget;
use crate::connect_failure::ConnectError;
use crate::context::{AttemptContext, SshEnv};
use crate::install_wire::{CleanupPhase, Mode, ProgramArgs, ServerPlatform};

const REMOTE_CLEANUP_TIMEOUT: Duration = Duration::from_secs(330);

/// Where a cleanup is, for the dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CleanupProgress {
    Connect,
    /// The core is stopped (or none ran): what became of it.
    Stop { detail: String },
    /// The files are removed: what went and what stayed.
    Remove { detail: String },
    Done,
}

pub struct CleanupOptions<'a> {
    /// Also delete `~/.mixdog-remote/user-data` (pairing, settings).
    pub remove_user_data: bool,
    /// Where the runtime to upload comes from, when the server holds none of this build.
    pub payloads: &'a dyn ServerPayloads,
}

/// What the server did with the core it found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoppedCore {
    pub pid: u64,
    pub stopped: bool,
    pub reason: Option<String>,
}

/// What a cleanup did: the core it stopped and the entries of `~/.mixdog-remote` it removed and kept.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CleanupReport {
    pub stopped: Option<StoppedCore>,
    pub removed: Vec<String>,
    pub kept: Vec<String>,
}

/// The `cleanup` object of a server result.
fn cleanup_result_of(result: &serde_json::Map<String, Value>) -> CleanupReport {
    let Some(cleanup) = result.get("cleanup").and_then(Value::as_object) else { return CleanupReport::default() };
    let names = |key: &str| -> Vec<String> {
        cleanup
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().map(|item| item.as_str().map_or_else(|| item.to_string(), str::to_owned)).collect())
            .unwrap_or_default()
    };
    let stopped = cleanup.get("stopped").and_then(Value::as_object).map(|stopped| StoppedCore {
        pid: stopped.get("pid").and_then(Value::as_u64).unwrap_or(0),
        stopped: stopped.get("stopped") == Some(&Value::Bool(true)),
        reason: stopped.get("reason").and_then(Value::as_str).map(str::to_owned),
    });
    CleanupReport { stopped, removed: names("removed"), kept: names("kept") }
}

fn describe_stop(stopped: Option<&StoppedCore>) -> String {
    match stopped {
        None => "no core running".to_owned(),
        Some(core) if core.stopped => format!("stopped pid {}", core.pid),
        Some(core) => format!("left pid {} running (not proven to be the desktop's core)", core.pid),
    }
}

fn describe_removal(removal: &CleanupReport) -> String {
    let removed = if removal.removed.is_empty() { "nothing".to_owned() } else { removal.removed.join(", ") };
    let kept = if removal.kept.is_empty() { String::new() } else { format!("; kept {}", removal.kept.join(", ")) };
    format!("removed {removed}{kept}")
}

/// Stops the core on the server, then removes what the desktop installed. The server refuses with `daemon-unproven`
/// when the core record names a process it cannot prove, and the remove run re-checks under its own lock hold that
/// nothing still runs from the install before deleting; either refusal ends the cleanup with nothing removed.
pub async fn cleanup_server(
    env: &SshEnv,
    context: &AttemptContext,
    target: &SshTarget,
    options: CleanupOptions<'_>,
    progress: &(dyn Fn(CleanupProgress) + Sync),
) -> Result<CleanupReport, ConnectError> {
    let remote = Remote { env, context, target };
    progress(CleanupProgress::Connect);
    let identity = options.payloads.identity();
    let (probed, platform) = remote.run(&base_args(identity, Mode::Probe), REMOTE_PROBE_TIMEOUT, None).await?;
    // The first run installs this build when it was missing; the second finds it.
    let installed = probed.get("installed") == Some(&Value::Bool(true));
    let args = |phase: CleanupPhase| {
        let mut args = base_args(identity, Mode::Cleanup);
        args.phase = Some(phase);
        args.remove_user_data = options.remove_user_data;
        args
    };
    let stopped = run_step(remote, options.payloads, platform, &args(CleanupPhase::Stop), installed).await?;
    progress(CleanupProgress::Stop { detail: describe_stop(stopped.stopped.as_ref()) });
    let removal = run_step(remote, options.payloads, platform, &args(CleanupPhase::Remove), true).await?;
    progress(CleanupProgress::Remove { detail: describe_removal(&removal) });
    progress(CleanupProgress::Done);
    Ok(CleanupReport { stopped: stopped.stopped, removed: removal.removed, kept: removal.kept })
}

async fn run_step(
    remote: Remote<'_>,
    payloads: &dyn ServerPayloads,
    platform: ServerPlatform,
    args: &ProgramArgs,
    installed: bool,
) -> Result<CleanupReport, ConnectError> {
    let result = remote.run_with_install(payloads, platform, args, installed, REMOTE_CLEANUP_TIMEOUT).await?;
    Ok(cleanup_result_of(&result))
}
