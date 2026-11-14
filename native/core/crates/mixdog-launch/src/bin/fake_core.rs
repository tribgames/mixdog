//! A stand-in for `mixdogd serve` for the launcher's integration tests: it claims the data folder the way the core does (one
//! winner; a contender that loses the claim exits cleanly with nothing to say), publishes discovery (`booting`, then `serving`),
//! and ends the way `FAKE_CORE_MODE` says. Never shipped: it is built only with the `fake-core` feature.
//!
//! Environment: `MIXDOG_RUNTIME_ROOT` is where discovery and the claim live; `FAKE_CORE_MODE` is `serve` (the default; runs until
//! `fake-core.stop` appears beside discovery), `crash-before-serving` (publishes `booting`, then panics) or `crash-after-serving`
//! (serves, then exits with status 7); `FAKE_CORE_BOOT_MS` is how long it stays `booting` (default 150).
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "a test core with no lane: it writes a few files and sleeps"
)]

use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use serde_json::json;

const LIFETIME: Duration = Duration::from_secs(60);

fn runtime_root() -> PathBuf {
    PathBuf::from(std::env::var_os("MIXDOG_RUNTIME_ROOT").expect("MIXDOG_RUNTIME_ROOT"))
}

fn publish(root: &Path, state: &str) {
    let serving = state == "serving";
    let mut core = json!({
        "version": "0.0.0-fake",
        "build": "fake",
        "instanceId": format!("fake-{}", std::process::id()),
        "processStartTime": "0",
        "state": state,
        "control": { "port": 4243 },
    });
    if serving {
        core["rpc"] = json!({ "port": 4242 });
    }
    let document = json!({ "pid": std::process::id(), "endpoints": { "session": { "port": 4243, "token": "fake-token" } }, "core": core });
    let staged = root.join(format!("daemon.json.{}.tmp", std::process::id()));
    std::fs::write(&staged, serde_json::to_vec(&document).expect("discovery")).expect("write discovery");
    std::fs::rename(&staged, root.join("daemon.json")).expect("publish discovery");
}

fn main() {
    if std::env::args().nth(1).as_deref() != Some("serve") {
        eprintln!("fake_core: usage: fake_core serve");
        std::process::exit(64);
    }
    let root = runtime_root();
    std::fs::create_dir_all(&root).expect("runtime root");
    // The claim: exactly one core serves; a contender that loses it ends cleanly (exit 0) and says nothing.
    if std::fs::OpenOptions::new().write(true).create_new(true).open(root.join("fake-core.claim")).is_err() {
        return;
    }
    let mode = std::env::var("FAKE_CORE_MODE").unwrap_or_else(|_| "serve".to_owned());
    let boot_ms = std::env::var("FAKE_CORE_BOOT_MS").ok().and_then(|ms| ms.parse().ok()).unwrap_or(150);
    publish(&root, "booting");
    std::thread::sleep(Duration::from_millis(boot_ms));
    if mode == "crash-before-serving" {
        panic!("the core lost its store");
    }
    publish(&root, "serving");
    if mode == "crash-after-serving" {
        std::thread::sleep(Duration::from_millis(300));
        std::process::exit(7);
    }
    let started = Instant::now();
    while !root.join("fake-core.stop").exists() && started.elapsed() < LIFETIME {
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::remove_file(root.join("daemon.json"));
}
