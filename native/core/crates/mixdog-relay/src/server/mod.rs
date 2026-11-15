//! The server assembly and its command line entry.

use std::process::ExitCode;

/// Runs the relay from the process environment. Replaced by the server assembly task.
pub fn run_cli() -> ExitCode {
    ExitCode::from(2)
}
