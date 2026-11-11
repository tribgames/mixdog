//! `server-ensure` modes `probe` and `cleanup`, kept from the 1.4.5 server program (the
//! desktop's SSH UI asks "what is installed and running" and offers "remove from server").
//!
//! `cleanup` differs from 1.4.5 in one place only: the core is retired through the one
//! wind-down procedure, so a core that still runs work is listed and waits for the user's
//! confirmation. A core that accepts the stop and stays silent is signalled, as Node's `stopDaemon` does.

use std::fs;

use super::args::CleanupPhase;
use super::args::ProgramArgs;
use super::error::EnsureError;
use super::flow::is_installed;
use super::flow::lock_options;
use super::flow::retire;
use super::host::CoreAccess;
use super::host::EnsureHost;
use super::install::InstallSpec;
use super::layout::RemotePaths;
use super::lock::InstallLock;
use super::report::CleanupResult;
use super::report::Report;
use super::report::Stopped;
use crate::lifecycle::StopReason;

/// Read-only: no lock, nothing written.
pub fn probe(args: &ProgramArgs, host: &dyn EnsureHost, access: &dyn CoreAccess) -> Result<Report, EnsureError> {
    let paths = RemotePaths::new(&host.home());
    let spec = InstallSpec {
        install_id: &args.install_id,
        version: &args.version,
        build: &args.build,
        sha256: args.sha256.as_deref(),
    };
    let version_dir = paths.version_dir(&args.install_id)?;
    let report = Report::base(&paths, host.uid(), &version_dir, is_installed(&paths, &spec)?);
    Ok(match access.discovery()? {
        Some(core) => report.with_core(&core, args),
        None => report,
    })
}

/// Retire, prove and remove inside one lock hold: no install or core start can slip in
/// between the check and the removal.
pub fn cleanup(args: &ProgramArgs, host: &dyn EnsureHost, access: &dyn CoreAccess) -> Result<Report, EnsureError> {
    let paths = RemotePaths::new(&host.home());
    let version_dir = paths.version_dir(&args.install_id)?;
    let report = Report::base(&paths, host.uid(), &version_dir, false);
    if !paths.root.exists() {
        return Ok(Report { cleanup: Some(CleanupResult::default()), ..report });
    }
    let lock = InstallLock::acquire(&paths.lock, &lock_options(args, "cleanup".to_owned()), host)?;

    let mut stopped = None;
    if let Some(core) = access.discovery()? {
        let answered = match access.stop_when_idle(&core, StopReason::UserStop, None)? {
            Some(drain) => match &args.confirm_token {
                Some(token) => access.stop_confirmed(&core, StopReason::UserStop, token, None)?,
                None if drain.running.is_empty() => true,
                None => return Err(EnsureError::Busy { server_version: core.version, drain }),
            },
            None => false,
        };
        retire(access, &core, answered)?;
        stopped = Some(Stopped { pid: core.pid, stopped: true });
    }

    let mut removed = Vec::new();
    let mut kept = Vec::new();
    if args.phase == Some(CleanupPhase::Remove) {
        assert_install_idle(&paths, host)?;
        let user_data = paths.user_data.file_name().map(std::ffi::OsStr::to_owned);
        let lock_name = paths.lock.file_name().map(std::ffi::OsStr::to_owned);
        let entries = fs::read_dir(&paths.root)
            .map_err(|e| EnsureError::InstallFailed(format!("Cannot list {}: {e}", paths.root.display())))?;
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name();
            if Some(&name) == lock_name.as_ref() {
                continue;
            }
            let label = name.to_string_lossy().into_owned();
            if Some(&name) == user_data.as_ref() && !args.remove_user_data {
                kept.push(label);
                continue;
            }
            let path = entry.path();
            let result = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
            result.map_err(|e| EnsureError::InstallFailed(format!("Cannot remove {}: {e}", path.display())))?;
            removed.push(label);
        }
    }
    drop(lock);
    if args.phase == Some(CleanupPhase::Remove) && kept.is_empty() {
        let _ = fs::remove_dir(&paths.root);
    }
    Ok(Report { cleanup: Some(CleanupResult { stopped, removed, kept }), ..report })
}

/// Nothing may still run from, or own, what a removal deletes. An unanswered process list is
/// never evidence that the install is idle.
fn assert_install_idle(paths: &RemotePaths, host: &dyn EnsureHost) -> Result<(), EnsureError> {
    let Some(images) = host.process_images() else {
        return Err(EnsureError::DaemonUnproven(format!(
            "Could not list the processes on the server to prove nothing still runs Mixdog from {}; nothing was removed.",
            paths.root.display()
        )));
    };
    let users: Vec<u32> = images
        .iter()
        .filter(|p| p.within(&paths.versions) || p.within(&paths.deps))
        .map(|p| p.pid)
        .collect();
    // A 1.4.5 daemon runs under node, so its image is not in the install; its data-dir record
    // names it.
    let owner = fs::read(paths.data_dir.join("daemon-owner.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|v| v.get("pid").and_then(serde_json::Value::as_u64))
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|&pid| pid != std::process::id() && host.process_alive(pid));
    let all: Vec<u32> = users.into_iter().chain(owner).collect();
    if all.is_empty() {
        return Ok(());
    }
    let listed = all.iter().take(3).map(|pid| format!("pid {pid}")).collect::<Vec<_>>().join(", ");
    Err(EnsureError::DaemonUnproven(format!(
        "A process the desktop did not stop still uses {} ({listed}); nothing was removed. Stop it on the server, then try again.",
        paths.root.display()
    )))
}
