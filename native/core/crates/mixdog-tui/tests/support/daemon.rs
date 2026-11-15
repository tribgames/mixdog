//! The machine a terminal UI child runs on: a private root (data folder, runtime root, home, working folder), the real
//! `mixdogd` laid out beside a `js-runtime.json` as the replays lay it out, a config that points the Anthropic provider at the
//! stand-in and marks onboarding done, and the environment of the child. The core is started by the child itself, through the
//! launcher's `ensure_core`, and is ended with the workspace.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use mixdog_cli::exec::boundary::{Boundary, BoundaryRequest, HostCredentials};
use portable_pty::CommandBuilder;
use serde_json::{Value, json};

use super::provider::Provider;
use super::{CHILD_ENV, child_spec};

pub const PROVIDER: &str = "anthropic";
pub const MODEL: &str = "claude-sonnet-4-6";
/// The key the stand-in accepts (it checks none).
const API_KEY: &str = "pty-end-to-end-key";

struct FakeCredentials;

impl HostCredentials for FakeCredentials {
    fn api_key(&self, _provider: &str) -> Option<String> {
        Some(API_KEY.to_owned())
    }

    fn pool_credential(&self, _provider: &str, _host_data_dir: &Path) -> Option<PathBuf> {
        None
    }
}

/// What a test wants beyond the plain machine.
#[derive(Clone, Copy, Debug, Default)]
pub struct Setup {
    /// A PreToolUse hook that asks the user about every call of this tool.
    pub ask_tool: Option<&'static str>,
}

pub struct Workspace {
    boundary: Boundary,
    install: tempfile::TempDir,
    exe: PathBuf,
    pub cwd: PathBuf,
    pub provider: Provider,
    /// Where the fake clipboard helpers write what they are given (Unix).
    pub clipboard_out: PathBuf,
    clip_dir: PathBuf,
}

/// The `mixdogd` under test: `MIXDOGD_BIN`, else the one the build left beside the test binaries' `deps` folder.
fn built_daemon() -> PathBuf {
    if let Some(bin) = std::env::var_os("MIXDOGD_BIN").filter(|bin| !bin.is_empty()) {
        return PathBuf::from(bin);
    }
    let name = if cfg!(windows) { "mixdogd.exe" } else { "mixdogd" };
    let exe = std::env::current_exe().expect("the test binary's path");
    let beside = exe.parent().and_then(Path::parent).map(|dir| dir.join(name));
    match beside {
        Some(path) if path.is_file() => path,
        other => panic!("mixdogd is not built ({other:?}): run `cargo build --offline -p mixdog-cli --bin mixdogd` first, or name it in MIXDOGD_BIN"),
    }
}

impl Workspace {
    pub fn new(setup: Setup) -> Self {
        let provider = Provider::start();
        let tmp = Path::new(env!("CARGO_TARGET_TMPDIR"));
        let host_env: BTreeMap<String, String> = std::env::vars().collect();
        let host_data = tmp.join("pty-no-host-data");
        let request = BoundaryRequest {
            provider: PROVIDER,
            model: MODEL,
            effort: None,
            fast: false,
            provider_config: None,
            host_env: &host_env,
            host_data_dir: &host_data,
            temp_dir: tmp,
            credentials: &FakeCredentials,
        };
        let boundary = Boundary::create(&request).expect("the private root");
        let root = boundary.root_dir.clone();

        // The config: the stand-in as the provider's endpoint, onboarding and the starter guide done.
        let config_path = boundary.data_dir.join("mixdog-config.json");
        let mut config: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).expect("the config")).expect("config JSON");
        config["agent"]["providers"][PROVIDER]["baseURL"] = json!(provider.base_url());
        config["agent"]["onboarding"] = json!({
            "completed": true,
            "version": 1,
            "completedAt": "2026-01-01T00:00:00.000Z",
            "starterGuide": { "closed": true, "welcomed": true, "visited": [] }
        });
        std::fs::write(&config_path, serde_json::to_string_pretty(&config).expect("config text")).expect("the config is written");

        let install = tempfile::Builder::new().prefix("pty-install-").tempdir_in(tmp).expect("the install folder");
        let exe = install.path().join(if cfg!(windows) { "mixdogd.exe" } else { "mixdogd" });
        std::fs::hard_link(built_daemon(), &exe).or_else(|_| std::fs::copy(built_daemon(), &exe).map(|_| ())).expect("mixdogd is laid out");
        let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..").canonicalize().expect("the package root");
        std::fs::write(install.path().join("js-runtime.json"), json!({ "program": "node", "packageRoot": package }).to_string()).expect("js-runtime.json");

        let cwd = root.join("project");
        std::fs::create_dir_all(&cwd).expect("the working folder");
        std::fs::create_dir_all(root.join("home")).expect("the home folder");
        std::fs::create_dir_all(root.join("config")).expect("the config folder");

        if let Some(tool) = setup.ask_tool {
            write_ask_hook(&boundary.data_dir, install.path(), tool);
        }
        let clip_dir = root.join("clipboard-helpers");
        let clipboard_out = root.join("clipboard.txt");
        write_clipboard_helpers(&clip_dir);
        Self { boundary, install, exe, cwd, provider, clipboard_out, clip_dir }
    }

    /// The command of the terminal UI child: this test binary on its `tui_child` test, with the private root's environment.
    pub fn child_command(&self) -> CommandBuilder {
        let mut command = CommandBuilder::new(std::env::current_exe().expect("the test binary"));
        command.args(["--exact", "tui_child", "--nocapture", "--test-threads=1"]);
        for (name, value) in &self.boundary.env {
            match value {
                Some(value) => command.env(name, value),
                None => command.env_remove(name),
            }
        }
        let root = &self.boundary.root_dir;
        command.cwd(&self.cwd);
        command.env("ANTHROPIC_API_KEY", API_KEY);
        command.env("MIXDOGD_BIN", &self.exe);
        command.env("MIXDOG_CONFIG_DIR", root.join("config"));
        command.env("HOME", root.join("home"));
        command.env("USERPROFILE", root.join("home"));
        command.env("MIXDOG_DAEMON_READY_TIMEOUT_MS", "60000");
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        // The fake helpers keep the real clipboard out of a copy on Unix.
        command.env("MIXDOG_E2E_CLIP_OUT", &self.clipboard_out);
        let path = std::env::var_os("PATH").unwrap_or_default();
        let joined = std::env::join_paths(std::iter::once(self.clip_dir.clone()).chain(std::env::split_paths(&path))).expect("a PATH");
        command.env("PATH", joined);
        command.env(CHILD_ENV, child_spec(&self.cwd.display().to_string(), PROVIDER, MODEL));
        command
    }

    /// The pid of the core the child started, from the discovery file of the private runtime root.
    fn core_pid(&self) -> Option<u32> {
        let bytes = std::fs::read(self.boundary.runtime_root.join("daemon.json")).ok()?;
        let document: Value = serde_json::from_slice(&bytes).ok()?;
        document["pid"].as_u64().and_then(|pid| u32::try_from(pid).ok())
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        if let Some(pid) = self.core_pid() {
            let pid = pid.to_string();
            let _ = if cfg!(windows) {
                std::process::Command::new("taskkill").args(["/F", "/T", "/PID", &pid]).output()
            } else {
                std::process::Command::new("kill").args(["-9", &pid]).output()
            };
        }
        // Windows releases a dead process's files a beat later.
        for _ in 0..20 {
            if std::fs::remove_dir_all(&self.boundary.root_dir).is_ok() || !self.boundary.root_dir.exists() {
                break;
            }
            std::thread::park_timeout(Duration::from_millis(150));
        }
    }
}

/// A user-level `hooks.json` whose PreToolUse handler answers `ask` for `tool`.
fn write_ask_hook(data_dir: &Path, install: &Path, tool: &str) {
    let answer = r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"pty end-to-end"}}"#;
    let script = if cfg!(windows) {
        let path = install.join("ask.cmd");
        std::fs::write(&path, format!("@echo off\r\necho {answer}\r\n")).expect("the hook script");
        path
    } else {
        let path = install.join("ask.sh");
        std::fs::write(&path, format!("#!/bin/sh\ncat > /dev/null\nprintf '%s' '{answer}'\n")).expect("the hook script");
        make_executable(&path);
        path
    };
    let command = format!("\"{}\"", script.display());
    let hooks = json!({ "hooks": { "PreToolUse": [ { "matcher": tool, "hooks": [ { "type": "command", "command": command } ] } ] } });
    std::fs::write(data_dir.join("hooks.json"), hooks.to_string()).expect("hooks.json");
}

/// `xclip`, `pbcopy` and `wl-copy` that write their input to the file `MIXDOG_E2E_CLIP_OUT` names. On Windows the clipboard
/// helper is `clip.exe` of the system and cannot be faked from `PATH`, so nothing is written there.
#[cfg(unix)]
fn write_clipboard_helpers(dir: &Path) {
    std::fs::create_dir_all(dir).expect("the helper folder");
    for name in ["xclip", "pbcopy", "wl-copy"] {
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\ncat > \"$MIXDOG_E2E_CLIP_OUT\"\n").expect("a fake helper");
        make_executable(&path);
    }
}

#[cfg(not(unix))]
fn write_clipboard_helpers(dir: &Path) {
    std::fs::create_dir_all(dir).expect("the helper folder");
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("a mode");
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}
