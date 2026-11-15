//! Filled in by the relay track task that owns this tool.

use std::process::ExitCode;

/// Not implemented yet: reports so on stderr and exits 2.
pub fn main(_args: &[String]) -> ExitCode {
    eprintln!("not implemented");
    ExitCode::from(2)
}
