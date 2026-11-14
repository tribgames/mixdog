//! Stands in for Chromium in the pool's tests (`required-features = ["test-support"]`). The first argument is the mode,
//! the second the pid file of the two modes that record one; the flags the pool appends after them are ignored.
//!
//! - `endpoint`: prints its DevTools endpoint on stderr and lives until its stdin closes.
//! - `silent`: lives and never prints an endpoint; records its pid in the pid file, then idles until killed.
//! - `stderr-closed`: records its pid, closes its stderr without printing an endpoint, then idles until killed.

#![allow(
    clippy::disallowed_methods,
    reason = "a test fake: it writes its pid file and blocks its own thread"
)]

use std::io::Write;

fn main() {
    let mut args = std::env::args().skip(1);
    let mode = args.next().unwrap_or_default();
    match mode.as_str() {
        "endpoint" => endpoint(),
        "silent" => {
            say("some startup noise, and no endpoint line\n");
            record_pid(args.next());
            idle();
        }
        "stderr-closed" => {
            record_pid(args.next());
            close_stderr();
            idle();
        }
        other => {
            say(&format!("ext_fake_browser: unknown mode {other:?}\n"));
            std::process::exit(2);
        }
    }
}

fn say(text: &str) {
    let mut err = std::io::stderr().lock();
    let _ = err.write_all(text.as_bytes());
    let _ = err.flush();
}

fn endpoint() {
    say("some startup noise\n");
    say(&format!(
        "DevTools listening on ws://127.0.0.1:9222/devtools/browser/fake-{}\n",
        std::process::id()
    ));
    // Alive until the pool closes its stdin.
    let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
}

fn record_pid(path: Option<String>) {
    let Some(path) = path else {
        say("ext_fake_browser: a pid file is required\n");
        std::process::exit(2);
    };
    if let Err(error) = std::fs::write(&path, std::process::id().to_string()) {
        say(&format!("ext_fake_browser: {path}: {error}\n"));
        std::process::exit(2);
    }
}

fn idle() -> ! {
    loop {
        std::thread::park();
    }
}

#[cfg(unix)]
fn close_stderr() {
    use std::os::fd::AsRawFd;
    use std::os::fd::FromRawFd;
    // SAFETY: fd 2 is this process's stderr; nothing writes to it afterwards, and dropping the owner closes it once.
    drop(unsafe { std::os::fd::OwnedFd::from_raw_fd(std::io::stderr().as_raw_fd()) });
}

#[cfg(windows)]
fn close_stderr() {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::io::FromRawHandle;
    // SAFETY: the handle is this process's stderr; nothing writes to it afterwards, and dropping the owner closes it once.
    drop(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(std::io::stderr().as_raw_handle()) });
}
