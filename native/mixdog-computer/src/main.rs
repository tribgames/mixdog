//! Computer Use desktop backend for Windows, macOS and Linux.
//!
//! The resident mode reads one JSON request per stdin line and answers each
//! with one marker-prefixed JSON envelope on stdout, so the core drives every
//! platform through one protocol. `--abort-cleanup` is the one-shot release a
//! stopped session runs from a fresh process.

mod a11y;
mod abort;
mod config;
mod elevated_launch;
mod host;
mod keys;
mod lease_api;
mod observer;
mod platform;
mod port;
mod protocol;
mod screen_input;
mod session;

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    match mode.as_str() {
        "--elevated-launch" => std::process::exit(elevated_launch::run()),
        "--elevated-input" => std::process::exit(host::elevated_input()),
        "--process-start-ticks" => std::process::exit(elevated_launch::process_start_ticks(&std::env::args().nth(2).unwrap_or_default())),
        "--abort-cleanup" => std::process::exit(abort::run()),
        "--version" => println!("mixdog-computer {}", env!("CARGO_PKG_VERSION")),
        "--probe" => std::process::exit(host::probe()),
        "--cursor-watchdog" => std::process::exit(platform::cursor_watchdog(&std::env::args().nth(2).unwrap_or_default())),
        "--screen-input" => std::process::exit(screen_input::run()),
        "--elevated-request" => {
            let args: Vec<String> = std::env::args().skip(2).collect();
            std::process::exit(host::elevated_worker(&args))
        }
        _ => host::run(),
    }
}
