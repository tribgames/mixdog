//! The host process of `tests/host_protocol.rs`, so the crate's tests need not start `mixdogd`: the same `host::run_with`
//! `mixdogd office-com-host` runs, with the scripted operations of `tests/support/scenario.rs` in place of Office's.
//! `office-com-host-test [--session]` is the stand-in for `mixdogd office-com-host [--session]`; `--live` (Windows) uses the
//! real apartment and a Word session opened through the dispatch layer, for the live test.

#[path = "../support/scenario.rs"]
mod scenario;

use std::ffi::OsString;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    #[cfg(windows)]
    let parts = if args.iter().any(|arg| arg == "--live") { scenario::live::handlers() } else { scenario::scripted() };
    #[cfg(not(windows))]
    let parts = scenario::scripted();
    let code = mixdog_office_com::host::run_with(&args, parts);
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
