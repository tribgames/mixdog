//! Computer Use desktop backend for macOS and Linux.
//!
//! The resident mode reads one JSON request per stdin line and answers each
//! with one marker-prefixed JSON envelope on stdout, the same contract the
//! Windows host speaks, so the desktop app drives every platform through one
//! protocol. `--abort-cleanup` is the one-shot release a stopped session runs
//! from a fresh process.

mod a11y;
mod abort;
mod config;
mod host;
mod keys;
mod observer;
mod platform;
mod protocol;
mod session;

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    match mode.as_str() {
        "--abort-cleanup" => std::process::exit(abort::run()),
        "--version" => println!("mixdog-computer {}", env!("CARGO_PKG_VERSION")),
        "--probe" => std::process::exit(host::probe()),
        _ => host::run(),
    }
}
