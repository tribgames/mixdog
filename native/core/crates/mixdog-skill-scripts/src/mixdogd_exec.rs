//! `pptx/scripts/lib/mixdogd-exec.mjs`: the headless one-shot the QC and review scripts run a model turn with,
//! `mixdogd exec` (native/core/crates/mixdog-cli/src/exec).
//!
//! The answer is what the child wrote on stdout, its errors what it wrote on stderr, and the exit code is returned;
//! a child that cannot start is exit code 1 with the reason on stderr. `tool_mode` is the daemon's spelling of the
//! runtime a caller wants (`--tool-mode readonly|full`).

use std::path::PathBuf;
use std::process::Stdio;

/// The variable that names the `mixdogd` to run instead of the one on the search path.
pub const BIN_ENV: &str = "MIXDOGD_BIN";

/// `--tool-mode`: the tools the model turn may use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolMode {
    Readonly,
    Full,
}

impl ToolMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolMode::Readonly => "readonly",
            ToolMode::Full => "full",
        }
    }
}

/// One `mixdogd exec` run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecOptions {
    pub message: String,
    pub provider: String,
    pub model: String,
    /// `--effort`; an empty value is left out, as an unset one is.
    pub effort: Option<String>,
    pub cwd: Option<PathBuf>,
    pub web_search: bool,
    pub usage_log_path: Option<String>,
    pub tool_mode: ToolMode,
    /// Variables the child gets on top of this process's own.
    pub env: Vec<(String, String)>,
}

/// What a run left behind.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExecResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs one model turn. The real one is [`Mixdogd`]; a test hands the scripts a recorded answer.
pub trait ExecRunner {
    fn run(&self, options: &ExecOptions) -> ExecResult;
}

/// The program to start: `MIXDOGD_BIN` when it is set and not empty, otherwise `mixdogd`.
pub fn mixdogd_bin(configured: Option<&str>) -> String {
    configured.filter(|bin| !bin.is_empty()).unwrap_or("mixdogd").to_owned()
}

/// The `mixdogd exec` arguments for one run.
pub fn mixdogd_exec_args(options: &ExecOptions) -> Vec<String> {
    let mut args: Vec<String> = ["exec", "--provider", options.provider.as_str(), "--model", options.model.as_str()].map(str::to_owned).into();
    if let Some(effort) = options.effort.as_deref().filter(|effort| !effort.is_empty()) {
        args.extend(["--effort".to_owned(), effort.to_owned()]);
    }
    if let Some(cwd) = options.cwd.as_ref().filter(|cwd| !cwd.as_os_str().is_empty()) {
        args.extend(["--cwd".to_owned(), cwd.to_string_lossy().into_owned()]);
    }
    if options.web_search {
        args.push("--web-search".to_owned());
    }
    if let Some(log) = options.usage_log_path.as_deref().filter(|log| !log.is_empty()) {
        args.extend(["--usage-log".to_owned(), log.to_owned()]);
    }
    args.extend(["--tool-mode".to_owned(), options.tool_mode.as_str().to_owned(), "--".to_owned(), options.message.clone()]);
    args
}

/// The real runner: starts `mixdogd exec` hidden and waits for it.
#[derive(Clone, Debug, Default)]
pub struct Mixdogd {
    bin: Option<String>,
}

#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the office scripts start `mixdogd exec` and wait for its output, as skill-run's interpreter start does; they have no runtime or lane")]
impl ExecRunner for Mixdogd {
    fn run(&self, options: &ExecOptions) -> ExecResult {
        let bin = mixdogd_bin(self.bin.as_deref());
        let mut command = std::process::Command::new(&bin);
        command.args(mixdogd_exec_args(options)).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(cwd) = options.cwd.as_ref().filter(|cwd| !cwd.as_os_str().is_empty()) {
            command.current_dir(cwd);
        }
        command.envs(options.env.iter().map(|(key, value)| (key, value)));
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
        match command.output() {
            Ok(output) => ExecResult {
                code: output.status.code().unwrap_or(1),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            },
            Err(error) => {
                let reason = match mixdog_js::uv_error::error_code(&error) {
                    Some(code) => format!("spawn {bin} {code}"),
                    None => error.to_string(),
                };
                ExecResult { code: 1, stdout: String::new(), stderr: format!("mixdogd exec could not start: {reason}\n") }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> ExecOptions {
        ExecOptions {
            message: "--looks like a flag".into(),
            provider: "p".into(),
            model: "m".into(),
            effort: Some("high".into()),
            cwd: Some(PathBuf::from("/deck")),
            web_search: false,
            usage_log_path: Some("/deck/r.usage.json".into()),
            tool_mode: ToolMode::Readonly,
            env: Vec::new(),
        }
    }

    #[test]
    fn a_run_is_one_exec_with_the_route_folder_usage_log_and_tool_mode() {
        let args = mixdogd_exec_args(&options());
        let want = [
            "exec", "--provider", "p", "--model", "m", "--effort", "high", "--cwd", "/deck", "--usage-log", "/deck/r.usage.json",
            "--tool-mode", "readonly", "--", "--looks like a flag",
        ];
        assert_eq!(args, want);
    }

    #[test]
    fn unset_options_are_left_out_and_web_search_is_a_flag() {
        let bare = ExecOptions {
            effort: Some(String::new()),
            cwd: None,
            usage_log_path: None,
            web_search: true,
            tool_mode: ToolMode::Full,
            ..options()
        };
        assert_eq!(
            mixdogd_exec_args(&bare),
            ["exec", "--provider", "p", "--model", "m", "--web-search", "--tool-mode", "full", "--", "--looks like a flag"]
        );
    }

    #[test]
    fn the_program_is_the_configured_one_or_mixdogd() {
        assert_eq!(mixdogd_bin(Some("/bin/mixdogd")), "/bin/mixdogd");
        assert_eq!(mixdogd_bin(Some("")), "mixdogd");
        assert_eq!(mixdogd_bin(None), "mixdogd");
    }


    #[test]
    fn a_mixdogd_that_cannot_start_is_exit_code_one_with_the_reason_on_stderr() {
        let missing = std::env::temp_dir().join("mixdog-skill-scripts-no-such-mixdogd").join("mixdogd");
        let result = Mixdogd::new(Some(missing.to_string_lossy().into_owned())).run(&ExecOptions { cwd: None, ..options() });
        assert_eq!(result.code, 1);
        assert!(result.stderr.starts_with("mixdogd exec could not start: "), "{}", result.stderr);
        assert!(result.stderr.ends_with('\n'));
    }
}


impl Mixdogd {
    /// The runner that starts `bin` (`MIXDOGD_BIN`'s value) or `mixdogd`.
    pub fn new(bin: Option<String>) -> Self {
        Self { bin }
    }

    /// The runner this process's environment names.
    pub fn from_env() -> Self {
        Self::new(std::env::var(BIN_ENV).ok())
    }
}
