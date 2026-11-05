//! `mixdogd server-ensure` (LR §8.1): one pass over what is observed on the server, so a run
//! that has to wait for the user (a busy core) returns and is simply run again.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::Duration;

use super::args::Mode;
use super::args::ModelLogin;
use super::args::ProgramArgs;
use super::error::EnsureError;
use super::host::CoreAccess;
use super::host::CoreReport;
use super::host::EnsureHost;
use super::host::Launch;
use super::install::InstallSpec;
use super::install::collect;
use super::install::ensure_installed;
use super::install::find_installed;
use super::install::record_current;
use super::layout::RemotePaths;
use super::lock::InstallLock;
use super::lock::LockOptions;
use super::manage;
use super::report::Replaced;
use super::report::Report;
use crate::compat;
use crate::compat::Order;
use crate::lifecycle::DiscoveryPhase;
use crate::lifecycle::StopReason;

/// The log is rotated past this size; one old generation is kept.
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_LOCK_WAIT_MS: u64 = 240_000;
const DEFAULT_LOCK_STALE_MS: u64 = 15 * 60_000;

/// One `server-ensure` run. `own_exe` is the running binary: the file installed when the
/// desktop uploaded it.
pub fn run(
    args: &ProgramArgs,
    host: &dyn EnsureHost,
    access: &dyn CoreAccess,
    own_exe: &Path,
) -> Result<Report, EnsureError> {
    match args.mode {
        Mode::Ensure => ensure(args, host, access, own_exe),
        Mode::Probe => manage::probe(args, host, access),
        Mode::Cleanup => manage::cleanup(args, host, access),
    }
}

pub(super) fn lock_options(args: &ProgramArgs, purpose: String) -> LockOptions {
    LockOptions {
        wait: Duration::from_millis(args.lock_wait_ms.unwrap_or(DEFAULT_LOCK_WAIT_MS)),
        stale: Duration::from_millis(args.lock_stale_ms.unwrap_or(DEFAULT_LOCK_STALE_MS)),
        purpose,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Decision {
    Attach,
    Replace,
    RefuseOutdated,
}

/// The one install decision (LR §8.1): the same `compat::order` as the `initialize` gate.
fn decide(order: Order) -> Decision {
    match order {
        Order::ClientNewer => Decision::Replace,
        Order::ClientOlder => Decision::RefuseOutdated,
        Order::Equal => Decision::Attach,
    }
}

fn ensure(
    args: &ProgramArgs,
    host: &dyn EnsureHost,
    access: &dyn CoreAccess,
    own_exe: &Path,
) -> Result<Report, EnsureError> {
    let desktop = compat::parse(&args.version).map_err(|e| EnsureError::BadVersion(e.0))?;
    let paths = RemotePaths::new(&host.home());
    let spec = InstallSpec {
        install_id: &args.install_id,
        version: &args.version,
        build: &args.build,
        sha256: args.sha256.as_deref(),
    };
    let version_dir = paths.version_dir(&args.install_id)?;
    private_dir(&paths.root)?;
    let _lock = InstallLock::acquire(&paths.lock, &lock_options(args, format!("install {}", args.install_id)), host)?;

    // A core of a newer version than this desktop is never touched, and nothing is installed.
    let found = access.discovery()?;
    let decision = match &found {
        Some(core) => {
            let server = compat::parse(&core.version).map_err(|e| EnsureError::BadVersion(e.0))?;
            let decision = decide(compat::order(&desktop, &server));
            if decision == Decision::RefuseOutdated {
                return Err(EnsureError::ClientOutdated {
                    desktop_version: args.version.clone(),
                    server_version: core.version.clone(),
                });
            }
            // Same version, other model-login mode: the only reason such a core is not current.
            if decision == Decision::Attach && core.model_proxy != args.wants_model_proxy() {
                Decision::Replace
            } else {
                decision
            }
        }
        None => Decision::Replace,
    };

    let installed = ensure_installed(&paths, &spec, host.now_ms(), args.upload.then_some(own_exe))?;
    let report = Report::base(&paths, host.uid(), &version_dir, true);

    let mut replaced = None;
    if let Some(core) = found {
        // A core already leaving is not one to attach to: it is waited out like a replaced one.
        if decision == Decision::Attach && core.state != DiscoveryPhase::Draining {
            let report = report.with_core(&core, args);
            let state = record_current(&paths, &args.install_id)?;
            return Ok(Report { gc_removed: collect_garbage(&paths, host, state), ..report });
        }
        if decision == Decision::Replace && core.state == DiscoveryPhase::Serving {
            access.hold(&core, true)?;
        }
        let drain = access.stop_when_idle(&core, StopReason::SshReplace)?;
        let retired = match &args.confirm_token {
            Some(token) => {
                access.stop_confirmed(&core, StopReason::SshReplace, token)?;
                true
            }
            None => drain.running.is_empty(),
        };
        if !retired {
            return Err(EnsureError::Busy { server_version: core.version, drain });
        }
        access.wait_exit(&core)?;
        replaced = Some(Replaced { pid: core.pid, version: core.version, graceful: true });
    }

    for dir in [&paths.runtime_root, &paths.user_data, &paths.mixdog_home, &paths.data_dir] {
        private_dir(dir)?;
    }
    rotate_log(&paths.log);
    let log_from = fs::metadata(&paths.log).map_or(0, |m| m.len());
    access.launch(&Launch {
        exe: installed.exe.clone(),
        args: vec!["serve".to_owned()],
        env: launch_env(&paths, args.model_login),
        env_remove: if args.wants_model_proxy() { Vec::new() } else { vec!["MIXDOG_MODEL_PROXY".to_owned()] },
        log: paths.log.clone(),
    })?;
    let core = match access.await_core()? {
        CoreReport::Reached(core) => core,
        CoreReport::Exited { status } => {
            return Err(EnsureError::CoreExited {
                status: status.map_or_else(|| "unknown".to_owned(), |s| s.to_string()),
                log: paths.log.display().to_string(),
                tail: log_tail(&paths.log, log_from),
            });
        }
    };

    let state = record_current(&paths, &args.install_id)?;
    let report = report.with_core(&core, args);
    Ok(Report { started: true, replaced, gc_removed: collect_garbage(&paths, host, state), ..report })
}

/// The desktop-managed core is kept apart from a core of the user's own install: its own runtime
/// root and Mixdog home live inside the version independent `user-data`.
fn launch_env(paths: &RemotePaths, model_login: Option<ModelLogin>) -> Vec<(String, String)> {
    let text = |path: &Path| path.to_string_lossy().into_owned();
    let mut env = vec![
        ("MIXDOG_RUNTIME_ROOT".to_owned(), text(&paths.runtime_root)),
        ("MIXDOG_HOME".to_owned(), text(&paths.mixdog_home)),
        ("MIXDOG_CONFIG_DIR".to_owned(), text(&paths.mixdog_home)),
        ("MIXDOG_DATA_DIR".to_owned(), text(&paths.data_dir)),
    ];
    if model_login != Some(ModelLogin::Server) {
        env.push(("MIXDOG_MODEL_PROXY".to_owned(), "client".to_owned()));
    }
    env
}

fn collect_garbage(paths: &RemotePaths, host: &dyn EnsureHost, state: super::install::InstallState) -> Vec<String> {
    let keep: HashSet<String> = [state.current, state.previous].into_iter().flatten().collect();
    let images = host.process_images();
    collect(paths, &keep, images.as_deref()).removed
}

/// `installed` of a probe: the wanted build is complete on the server.
pub(super) fn is_installed(paths: &RemotePaths, spec: &InstallSpec) -> Result<bool, EnsureError> {
    Ok(find_installed(paths, spec)?.is_some())
}

fn private_dir(dir: &std::path::Path) -> Result<(), EnsureError> {
    let failed = |e: std::io::Error| EnsureError::InstallFailed(format!("Cannot create {}: {e}", dir.display()));
    fs::create_dir_all(dir).map_err(failed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(failed)?;
    }
    Ok(())
}

/// Copy-then-truncate: the running core appends to the same descriptor and keeps writing at
/// the new end.
fn rotate_log(log: &std::path::Path) {
    if fs::metadata(log).is_ok_and(|m| m.len() > LOG_MAX_BYTES) {
        let rotated = log.with_extension("log.1");
        if fs::copy(log, rotated).is_ok() {
            let _ = fs::OpenOptions::new().write(true).truncate(true).open(log);
        }
    }
}

fn log_tail(log: &std::path::Path, from: u64) -> String {
    let bytes = fs::read(log).unwrap_or_default();
    let start = usize::try_from(from).unwrap_or(usize::MAX).min(bytes.len());
    let text = String::from_utf8_lossy(&bytes[start..]);
    let lines: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(8)..].join(" | ");
    if tail.is_empty() { "(no log output)".to_owned() } else { tail }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_follows_compat_order() {
        assert_eq!(decide(Order::ClientNewer), Decision::Replace);
        assert_eq!(decide(Order::ClientOlder), Decision::RefuseOutdated);
        assert_eq!(decide(Order::Equal), Decision::Attach);
    }
}
