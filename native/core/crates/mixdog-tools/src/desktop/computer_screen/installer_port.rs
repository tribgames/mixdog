//! The production side of the secure-desktop installer (Node: `secure-desktop/client.ts` and the glue of
//! `secure-desktop/install-request.ts`, `secureDesktopInstallerFor`): the bundled bridge executable
//! (`mixdog-secure-desktop.exe`) run as a child process for each [`InstallerPort`] call, and the one
//! [`SecureDesktopInstaller`] over it that PC access and the phone's helper request share.
//!
//! - `check` / `verify-image` / `start` run the bridge unelevated and read its exit code or last JSON line.
//! - `run_key_op` runs `install`, `enroll` or `revoke` by one of three authorizations: the UAC prompt
//!   (PowerShell `Start-Process -Verb RunAs`, which returns once the elevated process has finished), the
//!   batch logon from a Windows password (`--logon`, the credential only on the child's stdin), or the
//!   app-delegated path (`--delegated`, enroll and revoke only: no prompt, no credential).
//!
//! Off Windows nothing is run: `check` answers `unavailable`, `verify-image` refuses, `start` reports the
//! helper not installed. A launched child is never given up on: its thread lives until the process ends.

use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;

use tokio::sync::oneshot;

use super::installer::ELEVATION_DECLINED_EXIT;
use super::installer::HelperStatus;
use super::installer::ImageCheck;
use super::installer::InstallState;
use super::installer::InstallerPort;
use super::installer::KeyChangeOptions;
use super::installer::KeyChangeResult;
use super::installer::KeyOp;
use super::installer::KeyVerb;
use super::installer::SecureDesktopInstaller;
use super::installer::TokioTimers;
use super::router::BoxFuture;

/// `check --controller-key k`: installed and current, but that phone's key is not enrolled.
const NOT_ENROLLED_EXIT: i32 = 7;
const NOT_WINDOWS_DETAIL: &str = "the secure-desktop helper is Windows-only";
/// `CREATE_NO_WINDOW`: Node's `windowsHide`.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// One finished child: its exit code and what it wrote to stdout.
pub(super) struct Exit {
    pub code: i32,
    pub stdout: String,
}

/// Runs a program to its end. An error only when it could not be started or ended without an exit code.
pub(super) trait ProcessRunner: Send + Sync {
    /// `stdin`, when given, is written to the child's stdin which is then closed.
    fn run(&self, program: PathBuf, args: Vec<String>, stdin: Option<String>) -> BoxFuture<Result<Exit, String>>;
}

/// Children on their own threads: the one that waits on a UAC prompt may take as long as the person does.
pub(super) struct ChildProcesses;

impl ProcessRunner for ChildProcesses {
    fn run(&self, program: PathBuf, args: Vec<String>, stdin: Option<String>) -> BoxFuture<Result<Exit, String>> {
        let (done, answer) = oneshot::channel();
        std::thread::spawn(move || {
            // The thread runs the child to its end whether or not anyone still waits for the answer.
            let _ = done.send(run_child(&program, &args, stdin));
        });
        Box::pin(async move { answer.await.unwrap_or_else(|_| Err("the helper process thread ended without an answer".to_string())) })
    }
}

fn run_child(program: &std::path::Path, args: &[String], stdin: Option<String>) -> Result<Exit, String> {
    let mut command = Command::new(program);
    command.args(args).stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Some(text) = stdin
        && let Some(mut pipe) = child.stdin.take()
    {
        // A child that exits without reading it breaks the pipe: its exit code is the answer then.
        let _ = pipe.write_all(text.as_bytes());
    }
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    match output.status.code() {
        Some(code) => Ok(Exit { code, stdout: String::from_utf8_lossy(&output.stdout).into_owned() }),
        None => Err("the helper process ended without an exit code".to_string()),
    }
}

/// The install state for the exit code of the bridge's `check`: 0 current, 1 missing, 2 stale, 4 another
/// account's, 7 this phone's key not enrolled; anything else (the state cannot be determined) unavailable.
fn install_state_from_check_exit(code: i32) -> InstallState {
    match code {
        0 => InstallState::Installed,
        1 => InstallState::NotInstalled,
        2 => InstallState::Outdated,
        4 => InstallState::OtherUser,
        NOT_ENROLLED_EXIT => InstallState::NotEnrolled,
        _ => InstallState::Unavailable,
    }
}

/// The last non-empty line of the bridge's stdout, as JSON.
fn last_json_line(stdout: &str) -> Option<serde_json::Value> {
    let line = stdout.lines().map(str::trim).rfind(|line| !line.is_empty())?;
    serde_json::from_str(line).ok()
}

/// The `error` of the bridge's last JSON line, when it printed one.
fn bridge_error(stdout: &str) -> Option<String> {
    last_json_line(stdout)?.get("error")?.as_str().map(str::to_string)
}

/// The helper's status from the bridge's last JSON line; anything unreadable is "not installed".
fn parse_status(stdout: &str) -> HelperStatus {
    let Some(value) = last_json_line(stdout) else {
        return HelperStatus { installed: false, running: false, version: None };
    };
    HelperStatus {
        installed: value.get("installed").and_then(serde_json::Value::as_bool).unwrap_or(false),
        running: value.get("running").and_then(serde_json::Value::as_bool).unwrap_or(false),
        version: value.get("version").and_then(serde_json::Value::as_str).map(str::to_string),
    }
}

/// The bridge args of a key op: `install` and `enroll` take `--controller-key` for adds and `--revoke-key` for
/// the pending revokes of the same elevation; `revoke` takes `--controller-key` for the keys to remove.
fn key_op_args(verb: KeyVerb, keys: &[String], revoke: &[String]) -> Vec<String> {
    let mut args: Vec<String> = keys.iter().flat_map(|key| ["--controller-key".to_string(), key.clone()]).collect();
    if verb != KeyVerb::Revoke {
        args.extend(revoke.iter().flat_map(|key| ["--revoke-key".to_string(), key.clone()]));
    }
    args
}

fn verb_name(verb: KeyVerb) -> &'static str {
    match verb {
        KeyVerb::Install => "install",
        KeyVerb::Enroll => "enroll",
        KeyVerb::Revoke => "revoke",
    }
}

/// The PowerShell script that runs the bridge elevated and exits with its exit code: `Start-Process -Verb
/// RunAs -PassThru` goes through `ShellExecuteEx` and keeps the elevated process handle, the script waits on
/// it, so it ends exactly when the elevation has; a declined prompt (`ERROR_CANCELLED`) is exit 1223.
fn elevation_script(exe: &str, arguments: &[String]) -> String {
    let quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
    let list = arguments.iter().map(|argument| quote(argument)).collect::<Vec<_>>().join(",");
    [
        "try {".to_string(),
        format!("  $p = Start-Process -FilePath {} -ArgumentList @({list}) -Verb RunAs -WindowStyle Hidden -PassThru -ErrorAction Stop", quote(exe)),
        "} catch {".to_string(),
        "  $e = $_.Exception".to_string(),
        "  while ($e) {".to_string(),
        format!("    if ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq {ELEVATION_DECLINED_EXIT}) {{ exit {ELEVATION_DECLINED_EXIT} }}"),
        "    $e = $e.InnerException".to_string(),
        "  }".to_string(),
        "  [Console]::Error.WriteLine($_.Exception.Message)".to_string(),
        "  exit 1".to_string(),
        "}".to_string(),
        // Holding the handle keeps ExitCode readable after the process exits.
        "$null = $p.Handle".to_string(),
        "$p.WaitForExit()".to_string(),
        "exit $p.ExitCode".to_string(),
    ]
    .join("\n")
}

/// The [`InstallerPort`] over the bundled bridge executable.
pub(super) struct BridgePort {
    exe: PathBuf,
    runner: Arc<dyn ProcessRunner>,
    /// False off Windows: nothing is run.
    windows: bool,
}

impl BridgePort {
    pub(super) fn new(exe: PathBuf, runner: Arc<dyn ProcessRunner>, windows: bool) -> Self {
        Self { exe, runner, windows }
    }

    fn bridge(&self, args: Vec<String>, stdin: Option<String>) -> BoxFuture<Result<Exit, String>> {
        self.runner.run(self.exe.clone(), args, stdin)
    }
}

impl InstallerPort for BridgePort {
    fn check(&self, controller_key: Option<String>) -> BoxFuture<InstallState> {
        if !self.windows {
            return Box::pin(async { InstallState::Unavailable });
        }
        let mut args = vec!["check".to_string()];
        if let Some(key) = controller_key {
            args.extend(["--controller-key".to_string(), key]);
        }
        let ran = self.bridge(args, None);
        Box::pin(async move {
            match ran.await {
                Ok(exit) => install_state_from_check_exit(exit.code),
                Err(_) => InstallState::Unavailable,
            }
        })
    }

    fn verify_image(&self) -> BoxFuture<ImageCheck> {
        if !self.windows {
            return Box::pin(async { ImageCheck::Refused { detail: NOT_WINDOWS_DETAIL.to_string() } });
        }
        let ran = self.bridge(vec!["verify-image".to_string()], None);
        Box::pin(async move {
            match ran.await {
                Ok(Exit { code: 0, .. }) => ImageCheck::Ok,
                Ok(exit) => ImageCheck::Refused { detail: bridge_error(&exit.stdout).unwrap_or_else(|| format!("the helper exited with {}", exit.code)) },
                Err(message) => ImageCheck::Refused { detail: message },
            }
        })
    }

    fn start_service(&self) -> BoxFuture<HelperStatus> {
        if !self.windows {
            return Box::pin(async { HelperStatus { installed: false, running: false, version: None } });
        }
        let ran = self.bridge(vec!["start".to_string()], None);
        Box::pin(async move {
            // `start` exits non-zero when it could not reach a running state; it still printed its JSON.
            match ran.await {
                Ok(exit) => parse_status(&exit.stdout),
                Err(_) => HelperStatus { installed: false, running: false, version: None },
            }
        })
    }

    fn run_key_op(&self, op: KeyOp) -> BoxFuture<Result<i32, String>> {
        if !self.windows {
            return Box::pin(async { Err(NOT_WINDOWS_DETAIL.to_string()) });
        }
        let verb = verb_name(op.verb).to_string();
        let mut args = vec![verb];
        args.extend(key_op_args(op.verb, &op.keys, &op.revoke));
        let ran = if op.delegated == Some(true) && op.verb != KeyVerb::Install {
            args.push("--delegated".to_string());
            self.bridge(args, None)
        } else if let Some(credential) = op.credential {
            args.push("--logon".to_string());
            // The password goes only to the child's stdin: `<user>\n<password>`, an empty first line meaning
            // the account running the app.
            let stdin = format!("{}\n{}", credential.user.as_deref().unwrap_or(""), credential.password);
            self.bridge(args, Some(stdin))
        } else {
            let script = elevation_script(&self.exe.to_string_lossy(), &args);
            self.runner.run(
                PathBuf::from("powershell"),
                vec!["-NoProfile".to_string(), "-NonInteractive".to_string(), "-ExecutionPolicy".to_string(), "Bypass".to_string(), "-Command".to_string(), script],
                None,
            )
        };
        Box::pin(async move { ran.await.map(|exit| exit.code) })
    }
}

/// PC access's handle on the one secure-desktop installer: the state of the installed service, and the
/// admin-gated key ops (install, enroll, revoke) by any of the three authorizations. At most one admin action
/// runs at a time across every caller of the same helper; a second is answered `in-progress`, never queued.
pub struct PcAccessHelper {
    installer: SecureDesktopInstaller,
}

impl PcAccessHelper {
    /// The helper over the bridge executable at `exe` (Node: `secureDesktopExePath`: `native-tools/` of the
    /// package, else the crate's `target/release` in development). Must be made inside the runtime.
    pub fn new(exe: PathBuf) -> Self {
        Self::over(Arc::new(BridgePort::new(exe, Arc::new(ChildProcesses), cfg!(windows))))
    }

    fn over(port: Arc<dyn InstallerPort>) -> Self {
        Self { installer: SecureDesktopInstaller::new(port, Arc::new(TokioTimers::new()), None) }
    }

    /// The install state, relative to the phone's key when one is given; never prompts.
    pub async fn state(&self, controller_key: Option<String>) -> InstallState {
        self.installer.state(controller_key).await
    }

    /// Installs (or updates) the helper enrolling `keys`, applying `options.revoke` in the same elevation.
    pub async fn install(&self, keys: Vec<String>, options: KeyChangeOptions) -> KeyChangeResult {
        self.installer.install(keys, options).await
    }

    /// Enrolls `keys` into the installed helper in one authorization, applying `options.revoke`.
    pub async fn enroll(&self, keys: Vec<String>, options: KeyChangeOptions) -> KeyChangeResult {
        self.installer.enroll(keys, options).await
    }

    /// Revokes one phone's key.
    pub async fn revoke(&self, key: String, options: KeyChangeOptions) -> KeyChangeResult {
        self.installer.revoke(key, options).await
    }
}

#[cfg(test)]
#[path = "installer_port_tests.rs"]
mod tests;
