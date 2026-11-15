//! The run loop of the terminal UI (`src/tui/index.jsx` runTui), filled by `nr-tui-app-run`.

use std::process::ExitCode;

/// How the terminal UI is started (the CLI options of `mixdog`).
#[derive(Clone, Debug, Default)]
pub struct TuiOptions {
    pub cwd: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub fast: bool,
    pub web_search: bool,
}

/// Runs the terminal UI until it exits and returns the process exit code. The run loop is not connected yet: it says so once
/// at error level and fails.
pub fn run_tui(_options: TuiOptions) -> ExitCode {
    tracing::error!("the terminal UI run loop is not available in this build");
    ExitCode::FAILURE
}
