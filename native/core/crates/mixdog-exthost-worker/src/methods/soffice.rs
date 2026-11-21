//! The LibreOffice dependency of the document methods (`document.libreOfficeStatus`, `document.installLibreOffice`):
//! finding `soffice`, probing its version, and the guided install through winget or Homebrew.

use std::process::Stdio;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::watch;

use crate::error::CodedError;
use crate::registry::BoxFuture;

/// LibreOffice is a ~350MB download; winget/brew on a slow link can outlive the 10-minute budget the small CLIs use.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// A cold soffice start (first run, AV scan) can sit well past the default 15s run budget before printing its version line.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// What `scrubRuntimeRootVars` removes from a child's environment.
const SCRUBBED_VARS: [&str; 8] = [
    "MIXDOG_ROOT",
    "NODE_ENV",
    "MIXDOG_DAEMON_HOST",
    "MIXDOG_WORKER_MODE",
    "MIXDOG_DAEMON_SPAWNED_FOR",
    "MIXDOG_SUPERVISOR_PID",
    "MIXDOG_SERVER_PID",
    "ELECTRON_RUN_AS_NODE",
];

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Platform {
    Windows,
    Mac,
    Other,
}

impl Platform {
    const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Other
        }
    }

    fn separator(self) -> char {
        if self == Self::Windows { '\\' } else { '/' }
    }

    /// `path.join` for this platform's paths.
    fn join(self, parts: &[&str]) -> String {
        let separator = self.separator();
        let mut joined = String::new();
        for part in parts {
            if joined.is_empty() {
                joined.push_str(part);
                continue;
            }
            if !joined.ends_with(separator) {
                joined.push(separator);
            }
            joined.push_str(part.trim_start_matches(separator));
        }
        joined
    }
}

/// An environment variable as Node's `||` reads it: unset and empty are both absent.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

/// The programs to try, in order (`sofficeCandidates`).
pub(super) fn candidates(platform: Platform, env: &dyn Fn(&str) -> Option<String>, home: &str) -> Vec<String> {
    let join = |parts: &[&str]| platform.join(parts);
    match platform {
        // soffice.com is the console front-end: it reports through stdio and exits. soffice.exe is a GUI launcher that may do
        // neither.
        Platform::Windows => {
            let program_files = non_empty(env("ProgramFiles")).unwrap_or_else(|| "C:\\Program Files".to_owned());
            let program_files_x86 = non_empty(env("ProgramFiles(x86)")).unwrap_or_else(|| "C:\\Program Files (x86)".to_owned());
            let local_app_data = non_empty(env("LOCALAPPDATA"));
            let mut list = vec![
                "soffice.com".to_owned(),
                join(&[&program_files, "LibreOffice", "program", "soffice.com"]),
                join(&[&program_files_x86, "LibreOffice", "program", "soffice.com"]),
            ];
            if let Some(local) = local_app_data {
                list.push(join(&[&local, "Programs", "LibreOffice", "program", "soffice.com"]));
            }
            list
        }
        Platform::Mac => vec![
            "soffice".to_owned(),
            "/Applications/LibreOffice.app/Contents/MacOS/soffice".to_owned(),
            join(&[home, "Applications", "LibreOffice.app", "Contents", "MacOS", "soffice"]),
            "/opt/homebrew/bin/soffice".to_owned(),
            "/usr/local/bin/soffice".to_owned(),
        ],
        Platform::Other => vec![
            "soffice".to_owned(),
            "libreoffice".to_owned(),
            "/usr/lib/libreoffice/program/soffice".to_owned(),
            "/snap/bin/libreoffice".to_owned(),
            "/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice".to_owned(),
            join(&[home, ".local", "share", "flatpak", "exports", "bin", "org.libreoffice.LibreOffice"]),
        ],
    }
}

/// What a bounded child run ended with. ENOENT is flattened to code -1 so a missing binary reads apart from a failing one.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct RunOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a program to its end within a budget.
pub(super) trait Runner: Send + Sync {
    fn run(&self, file: &str, args: &[String], timeout: Duration) -> BoxFuture<RunOutput>;
}

/// The operating system's processes.
struct ChildRunner;

#[derive(Clone, Debug, PartialEq)]
struct Found {
    version: String,
}

/// `/LibreOffice (\d[\w.]*)/`: the version word after the first `LibreOffice ` that has a digit next.
fn version_of(output: &str) -> String {
    let mut rest = output;
    while let Some(at) = rest.find("LibreOffice ") {
        let after = &rest[at + "LibreOffice ".len()..];
        if after.starts_with(|c: char| c.is_ascii_digit()) {
            let end = after.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.')).unwrap_or(after.len());
            return after[..end].to_owned();
        }
        rest = after;
    }
    String::new()
}

#[derive(Default)]
struct State {
    /// `None` until a probe ran; then `Some(None)` for none found.
    cached: Option<Option<Found>>,
    /// The probe a refresh is running, which a concurrent refresh joins.
    refreshing: Option<watch::Receiver<bool>>,
}

pub(super) struct Soffice {
    platform: Platform,
    candidates: Box<dyn Fn() -> Vec<String> + Send + Sync>,
    runner: Arc<dyn Runner>,
    state: Mutex<State>,
}

/// Ends a refresh: clears it from the state and wakes the calls that joined it (also when the leader is dropped).
struct RefreshEnd<'a> {
    soffice: &'a Soffice,
    done: watch::Sender<bool>,
}

impl Drop for RefreshEnd<'_> {
    fn drop(&mut self) {
        self.soffice.state.lock().unwrap_or_else(PoisonError::into_inner).refreshing = None;
        self.done.send_replace(true);
    }
}

const LABEL: &str = "LibreOffice";
const HOMEPAGE: &str = "https://www.libreoffice.org";

struct InstallSpec {
    program: &'static str,
    args: Vec<String>,
    manager: &'static str,
    manager_name: &'static str,
}

fn install_spec(platform: Platform) -> Result<InstallSpec, CodedError> {
    let args = |list: &[&str]| list.iter().map(|arg| (*arg).to_owned()).collect();
    match platform {
        Platform::Windows => Ok(InstallSpec {
            program: "winget",
            args: args(&[
                "install",
                "--id",
                "TheDocumentFoundation.LibreOffice",
                "--exact",
                "--source",
                "winget",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--disable-interactivity",
            ]),
            manager: "winget",
            manager_name: "winget",
        }),
        Platform::Mac => Ok(InstallSpec { program: "brew", args: args(&["install", "--cask", "libreoffice"]), manager: "brew", manager_name: "Homebrew" }),
        Platform::Other => Err(CodedError::new(
            "install_unsupported",
            "Automatic LibreOffice installation is not supported on Linux. Install it with your package manager \
             (for example `sudo apt install libreoffice` or `sudo dnf install libreoffice`) or from https://www.libreoffice.org.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    type Script = dyn Fn(&str, &[String]) -> RunOutput + Send + Sync;

    /// A runner that answers from a script and counts its runs.
    struct Scripted {
        script: Box<Script>,
        runs: AtomicUsize,
        log: Mutex<Vec<(String, Vec<String>, Duration)>>,
    }

    impl Runner for Scripted {
        fn run(&self, file: &str, args: &[String], timeout: Duration) -> BoxFuture<RunOutput> {
            self.runs.fetch_add(1, Ordering::SeqCst);
            self.log.lock().unwrap().push((file.to_owned(), args.to_vec(), timeout));
            let output = (self.script)(file, args);
            Box::pin(async move {
                // A real run yields; a refresh that starts meanwhile joins this one.
                tokio::task::yield_now().await;
                output
            })
        }
    }

    fn scripted(script: impl Fn(&str, &[String]) -> RunOutput + Send + Sync + 'static) -> Arc<Scripted> {
        Arc::new(Scripted { script: Box::new(script), runs: AtomicUsize::new(0), log: Mutex::new(Vec::new()) })
    }

    fn ok(stdout: &str) -> RunOutput {
        RunOutput { code: 0, stdout: stdout.to_owned(), stderr: String::new() }
    }

    fn soffice(platform: Platform, list: &[&str], runner: Arc<Scripted>) -> Soffice {
        let list: Vec<String> = list.iter().map(|item| (*item).to_owned()).collect();
        Soffice::with(platform, Box::new(move || list.clone()), runner)
    }

    #[test]
    fn the_candidates_follow_the_platform() {
        let none = |_: &str| None;
        let windows = candidates(Platform::Windows, &none, "");
        assert_eq!(windows[0], "soffice.com");
        assert_eq!(windows[1], "C:\\Program Files\\LibreOffice\\program\\soffice.com");
        assert_eq!(windows[2], "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com");
        assert_eq!(windows.len(), 3, "no LOCALAPPDATA, no candidate under it");
        let env = |name: &str| match name {
            "ProgramFiles" => Some("D:\\Apps".to_owned()),
            "LOCALAPPDATA" => Some("C:\\Users\\a\\AppData\\Local".to_owned()),
            _ => None,
        };
        let windows = candidates(Platform::Windows, &env, "");
        assert_eq!(windows[1], "D:\\Apps\\LibreOffice\\program\\soffice.com");
        assert_eq!(windows[3], "C:\\Users\\a\\AppData\\Local\\Programs\\LibreOffice\\program\\soffice.com");
        let mac = candidates(Platform::Mac, &none, "/Users/a");
        assert_eq!(mac[2], "/Users/a/Applications/LibreOffice.app/Contents/MacOS/soffice");
        assert_eq!(mac.len(), 5);
        let linux = candidates(Platform::Other, &none, "/home/a");
        assert_eq!(&linux[..2], ["soffice", "libreoffice"]);
        assert_eq!(linux[5], "/home/a/.local/share/flatpak/exports/bin/org.libreoffice.LibreOffice");
        assert!(linux.contains(&"/snap/bin/libreoffice".to_owned()));
    }

    #[test]
    fn the_version_is_the_word_after_libreoffice() {
        assert_eq!(version_of("LibreOffice 24.2.1.2 abc"), "24.2.1.2");
        assert_eq!(version_of("The LibreOffice team\nLibreOffice 7.6.4_x\n"), "7.6.4_x");
        assert_eq!(version_of("LibreOffice"), "");
        assert_eq!(version_of("v18.0.0"), "");
    }

    #[tokio::test]
    async fn the_probe_reports_a_version_only_when_the_program_prints_one() {
        let runner = scripted(|file, _| match file {
            "versioned" => ok("LibreOffice 24.8.0.3"),
            "silent" => ok(""),
            _ => RunOutput { code: 1, stdout: String::new(), stderr: "no".to_owned() },
        });
        let probe = soffice(Platform::Other, &["failing", "versioned"], runner.clone());
        assert_eq!(probe.status(false).await, json!({"installed": true, "version": "24.8.0.3"}));
        let log = runner.log.lock().unwrap().clone();
        assert_eq!(log[0], ("failing".to_owned(), vec!["--version".to_owned()], PROBE_TIMEOUT));
        assert_eq!(log.len(), 2);
        let silent = soffice(Platform::Other, &["silent"], runner.clone());
        assert_eq!(silent.status(false).await, json!({"installed": true}));
        let none = soffice(Platform::Other, &[], runner);
        assert_eq!(none.status(false).await, json!({"installed": false}));
    }

    #[tokio::test]
    async fn the_answer_is_cached_until_a_refresh_and_a_missing_path_is_not_run() {
        let runner = scripted(|_, _| ok("LibreOffice 1.0"));
        let probe = soffice(Platform::Other, &["/no/such/dir/soffice", "ok"], runner.clone());
        assert_eq!(probe.status(false).await["installed"], json!(true));
        assert_eq!(runner.runs.load(Ordering::SeqCst), 1, "a path that is not there is skipped without a run");
        probe.status(false).await;
        assert_eq!(runner.runs.load(Ordering::SeqCst), 1);
        probe.refresh().await;
        assert_eq!(runner.runs.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn concurrent_refreshes_share_one_probe() {
        let runner = scripted(|_, _| ok(""));
        let probe = Arc::new(soffice(Platform::Other, &["ok"], runner.clone()));
        tokio::join!(probe.refresh(), probe.refresh());
        assert_eq!(runner.runs.load(Ordering::SeqCst), 1);
        probe.refresh().await;
        assert_eq!(runner.runs.load(Ordering::SeqCst), 2, "a refresh after the probe ended probes again");
    }

    #[tokio::test]
    async fn an_installed_libreoffice_is_a_status_never_a_package_manager_run() {
        let runner = scripted(|_, _| ok("LibreOffice 7.0"));
        let probe = soffice(Platform::Windows, &["soffice.com"], runner.clone());
        let status = probe.install(Box::pin(async { panic!("no fonts for an existing install") })).await.unwrap();
        assert_eq!(status, json!({"installed": true, "version": "7.0"}));
        assert_eq!(runner.runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn the_install_runs_winget_with_its_arguments_and_the_budget() {
        let installed = Arc::new(AtomicUsize::new(0));
        let flag = installed.clone();
        let runner = scripted(move |file, _| {
            if file == "winget" {
                flag.store(1, Ordering::SeqCst);
                ok("done")
            } else if flag.load(Ordering::SeqCst) == 1 {
                ok("LibreOffice 24.2.0")
            } else {
                RunOutput { code: -1, stdout: String::new(), stderr: "ENOENT".to_owned() }
            }
        });
        let probe = soffice(Platform::Windows, &["soffice.com"], runner.clone());
        let fonts = Arc::new(AtomicUsize::new(0));
        let counted = fonts.clone();
        let status = probe.install(Box::pin(async move { counted.store(1, Ordering::SeqCst) })).await.unwrap();
        assert_eq!(status, json!({"installed": true, "version": "24.2.0"}));
        assert_eq!(fonts.load(Ordering::SeqCst), 1, "the fonts follow a successful install");
        let log = runner.log.lock().unwrap().clone();
        let install = log.iter().find(|entry| entry.0 == "winget").unwrap();
        assert_eq!(install.2, Duration::from_secs(1200));
        assert_eq!(install.1[..3], ["install", "--id", "TheDocumentFoundation.LibreOffice"]);
        assert_eq!(install.1.last().map(String::as_str), Some("--disable-interactivity"));
    }

    #[tokio::test]
    async fn the_install_failures_carry_their_codes_and_messages() {
        let missing = soffice(Platform::Mac, &["soffice"], scripted(|_, _| RunOutput { code: -1, stdout: String::new(), stderr: "ENOENT".to_owned() }));
        let error = missing.install(Box::pin(async {})).await.unwrap_err();
        assert_eq!(
            (error.code.as_str(), error.message.as_str()),
            ("package_manager_unavailable", "Homebrew is unavailable. Install LibreOffice from https://www.libreoffice.org and try again.")
        );
        let failing = soffice(
            Platform::Windows,
            &["soffice.com"],
            scripted(|file, _| {
                if file == "winget" {
                    RunOutput { code: 3, stdout: "first\nlast line\n\n".to_owned(), stderr: String::new() }
                } else {
                    RunOutput { code: -1, stdout: String::new(), stderr: String::new() }
                }
            }),
        );
        let error = failing.install(Box::pin(async {})).await.unwrap_err();
        assert_eq!((error.code.as_str(), error.message.as_str()), ("install_failed", "winget could not install LibreOffice: last line"));
        let quiet = soffice(
            Platform::Mac,
            &["soffice"],
            scripted(|file, _| {
                if file == "brew" {
                    RunOutput { code: 7, stdout: String::new(), stderr: " \n".to_owned() }
                } else {
                    RunOutput { code: -1, stdout: String::new(), stderr: String::new() }
                }
            }),
        );
        let error = quiet.install(Box::pin(async {})).await.unwrap_err();
        assert_eq!(error.message, "brew could not install LibreOffice: exit code 7");
        let not_found = soffice(
            Platform::Mac,
            &["soffice"],
            scripted(|file, _| if file == "brew" { ok("") } else { RunOutput { code: -1, stdout: String::new(), stderr: String::new() } }),
        );
        let error = not_found.install(Box::pin(async {})).await.unwrap_err();
        assert_eq!(
            (error.code.as_str(), error.message.as_str()),
            ("executable_not_found", "LibreOffice installed, but the executable was not found yet. Restart Mixdog Desktop to pick it up.")
        );
        let linux = soffice(Platform::Other, &["soffice"], scripted(|_, _| RunOutput { code: -1, stdout: String::new(), stderr: String::new() }));
        let error = linux.install(Box::pin(async {})).await.unwrap_err();
        assert_eq!(error.code, "install_unsupported");
        assert!(error.message.starts_with("Automatic LibreOffice installation is not supported on Linux."));
    }

    #[test]
    fn a_path_joins_with_its_platforms_separator() {
        assert_eq!(Platform::Windows.join(&["C:\\a\\", "b", "c.exe"]), "C:\\a\\b\\c.exe");
        assert_eq!(Platform::Other.join(&["/home/a", ".local", "x"]), "/home/a/.local/x");
    }

    #[tokio::test]
    async fn a_program_that_is_not_there_runs_as_code_minus_one() {
        let missing = std::env::temp_dir().join("mixdog-no-such-program-for-soffice-tests");
        let output = ChildRunner.run(&missing.to_string_lossy(), &[], Duration::from_secs(5)).await;
        assert_eq!(output, RunOutput { code: -1, stdout: String::new(), stderr: "ENOENT".to_owned() });
    }
}

impl Runner for ChildRunner {
    fn run(&self, file: &str, args: &[String], timeout: Duration) -> BoxFuture<RunOutput> {
        let file = file.to_owned();
        let args = args.to_vec();
        Box::pin(async move { run_child(&file, &args, timeout).await })
    }
}
async fn run_child(file: &str, args: &[String], timeout: Duration) -> RunOutput {
    let mut command = tokio::process::Command::new(file);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for name in SCRUBBED_VARS {
        command.env_remove(name);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return RunOutput { code: -1, stdout: String::new(), stderr: "ENOENT".to_owned() };
        }
        Err(error) => return RunOutput { code: 1, stdout: String::new(), stderr: error.to_string() },
    };
    // execFile's error message names the whole command line: `Command failed: <file> <args...>`.
    let failed = || {
        let line: Vec<&str> = std::iter::once(file).chain(args.iter().map(String::as_str)).collect();
        format!("Command failed: {}", line.join(" "))
    };
    // A child that outlives its budget is killed when the wait is dropped (`kill_on_drop`).
    match mixdog_rt::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            match output.status.code() {
                Some(0) => RunOutput { code: 0, stdout, stderr },
                code => RunOutput { code: code.unwrap_or(1), stdout, stderr: if stderr.is_empty() { failed() } else { stderr } },
            }
        }
        Ok(Err(error)) => RunOutput { code: 1, stdout: String::new(), stderr: error.to_string() },
        Err(_) => RunOutput { code: 1, stdout: String::new(), stderr: failed() },
    }
}
fn home_dir() -> String {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(key).unwrap_or_default()
}
impl Soffice {
    /// The probe of this machine: its platform's candidates, its processes.
    pub(super) fn for_platform() -> Self {
        let platform = Platform::current();
        Self::with(platform, Box::new(move || candidates(platform, &|name| std::env::var(name).ok(), &home_dir())), Arc::new(ChildRunner))
    }

    pub(super) fn with(platform: Platform, candidates: Box<dyn Fn() -> Vec<String> + Send + Sync>, runner: Arc<dyn Runner>) -> Self {
        Self { platform, candidates, runner, state: Mutex::new(State::default()) }
    }

    async fn resolve(&self, refresh: bool) -> Option<Found> {
        if !refresh && let Some(cached) = self.state.lock().unwrap_or_else(PoisonError::into_inner).cached.clone() {
            return cached;
        }
        let mut found = None;
        for candidate in (self.candidates)() {
            if candidate.contains(['\\', '/']) && !mixdog_fsio::exists(&mixdog_fsio::Unlaned, &candidate).unwrap_or(false) {
                continue;
            }
            let probe = self.runner.run(&candidate, &["--version".to_owned()], PROBE_TIMEOUT).await;
            if probe.code == 0 {
                found = Some(Found { version: version_of(&probe.stdout) });
                break;
            }
        }
        self.state.lock().unwrap_or_else(PoisonError::into_inner).cached = Some(found.clone());
        found
    }

    /// `{installed: false}`, or `{installed: true}` with the version when the program printed one.
    pub(super) async fn status(&self, refresh: bool) -> Value {
        match self.resolve(refresh).await {
            None => json!({"installed": false}),
            Some(found) if found.version.is_empty() => json!({"installed": true}),
            Some(found) => json!({"installed": true, "version": found.version}),
        }
    }

    /// Re-probes (a failed Office preview regaining focus); concurrent refreshes share the probe already running.
    pub(super) async fn refresh(&self) {
        let lead = {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            match &state.refreshing {
                Some(running) => Err(running.clone()),
                None => {
                    let (done, running) = watch::channel(false);
                    state.refreshing = Some(running);
                    Ok(done)
                }
            }
        };
        match lead {
            Err(mut running) => {
                let _ = running.wait_for(|done| *done).await;
            }
            Ok(done) => {
                let _end = RefreshEnd { soffice: self, done };
                self.resolve(true).await;
            }
        }
    }

    /// Guided install: winget on Windows, brew on macOS, and an `install_unsupported` answer elsewhere. The install click may
    /// race a probe that never ran (or ran before a manual install), and winget treats "already installed" as a failure, so a
    /// fresh probe answers first. `fonts` runs after a successful install.
    pub(super) async fn install(&self, fonts: BoxFuture<()>) -> Result<Value, CodedError> {
        let existing = self.status(true).await;
        if existing["installed"] == json!(true) {
            return Ok(existing);
        }
        let spec = install_spec(self.platform)?;
        let result = self.runner.run(spec.program, &spec.args, INSTALL_TIMEOUT).await;
        if result.code == -1 {
            return Err(CodedError::new(
                "package_manager_unavailable",
                format!("{} is unavailable. Install {LABEL} from {HOMEPAGE} and try again.", spec.manager_name),
            ));
        }
        if result.code != 0 {
            let output = if result.stderr.is_empty() { &result.stdout } else { &result.stderr };
            let detail = output.trim().split('\n').rfind(|line| !line.is_empty()).map(str::to_owned);
            return Err(CodedError::new(
                "install_failed",
                format!("{} could not install {LABEL}: {}", spec.manager, detail.unwrap_or_else(|| format!("exit code {}", result.code))),
            ));
        }
        let status = self.status(true).await;
        if status["installed"] != json!(true) {
            return Err(CodedError::new(
                "executable_not_found",
                "LibreOffice installed, but the executable was not found yet. Restart Mixdog Desktop to pick it up.",
            ));
        }
        // The Noto faces LibreOffice renders with come in alongside it; a missing or offline provisioner never fails the
        // install itself.
        fonts.await;
        Ok(status)
    }
}
