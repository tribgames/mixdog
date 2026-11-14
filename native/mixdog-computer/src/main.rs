//! Computer Use desktop backend for Windows, macOS and Linux.
//!
//! The resident mode reads one JSON request per stdin line and answers each
//! with one marker-prefixed JSON envelope on stdout, so the core drives every
//! platform through one protocol. `--abort-cleanup` is the one-shot release a
//! stopped session runs from a fresh process.

mod a11y;
mod abort;
mod config;
mod host;
mod keys;
mod lease_api;
mod observer;
mod platform;
mod protocol;
mod screen_input;
mod session;

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    match mode.as_str() {
        "--abort-cleanup" => std::process::exit(abort::run()),
        "--version" => println!("mixdog-computer {}", env!("CARGO_PKG_VERSION")),
        "--probe" => std::process::exit(host::probe()),
        // `--cursor-watchdog <parent_pid>`: the child that keeps the cursor
        // theme and restores it when its parent dies (CursorTheme.cs).
        "--cursor-watchdog" => std::process::exit(platform::cursor_watchdog(
            &std::env::args().nth(2).unwrap_or_default(),
        )),
        // `--elevated-request <dir> ...`: the one-action worker a UAC launch
        // starts (elevated-program.ts).
        // `--screen-input`: the remote screen's input process
        // (remote-screen/screen-input-host.ts).
        "--screen-input" => std::process::exit(screen_input::run()),
        "--elevated-request" => {
            let args: Vec<String> = std::env::args().skip(2).collect();
            std::process::exit(host::elevated_worker(&args))
        }
        _ => host::run(),
    }
}
