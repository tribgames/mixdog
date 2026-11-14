//! `ensure_core` against the test core `fake_core` (a stand-in for `mixdogd serve` that writes discovery the way the core
//! does): a core is started and attached to, two launchers racing for one core both attach to the winner, and a core that
//! ends leaves its capture and sidecar. Runs only with the `fake-core` feature.
#![cfg(feature = "fake-core")]
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the test lays out folders, starts a process and reads what it left on disk"
)]

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use mixdog_launch::crash_capture::process_runs;
use mixdog_launch::ensure_core::EnsureError;
use mixdog_launch::ensure_core::EnsureOptions;
use mixdog_launch::ensure_core::ensure_core;
use serde_json::Value;

const FAKE_CORE: &str = env!("CARGO_BIN_EXE_fake_core");
const WAIT: Duration = Duration::from_secs(30);

struct World {
    _root: tempfile::TempDir,
    runtime: PathBuf,
    data: PathBuf,
}

impl World {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("runtime");
        let data = root.path().join("data");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        Self { _root: root, runtime, data }
    }

    fn options(&self, mode: &str) -> EnsureOptions {
        EnsureOptions {
            bin: Some(PathBuf::from(FAKE_CORE)),
            ready_timeout: WAIT,
            discovery_path: Some(self.runtime.join("daemon.json")),
            data_dir: Some(self.data.clone()),
            env: vec![(OsString::from("MIXDOG_RUNTIME_ROOT"), self.runtime.clone().into_os_string()), (OsString::from("FAKE_CORE_MODE"), OsString::from(mode))],
            ..EnsureOptions::default()
        }
    }

    fn captures(&self) -> PathBuf {
        self.data.join("daemon-crash")
    }

    fn sidecars(&self) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(self.captures()) else { return Vec::new() };
        let mut files: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).filter(|path| path.extension().is_some_and(|ext| ext == "json")).collect();
        files.sort();
        files
    }

    /// Ends the test core and waits for it to be gone.
    fn stop(&self, pid: u32) {
        std::fs::write(self.runtime.join("fake-core.stop"), b"").unwrap();
        until("the test core ends", || !process_runs(pid));
    }
}

fn until(what: &str, mut done: impl FnMut() -> bool) {
    let end = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < end, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn record(file: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap()
}

/// The keys a launcher's sidecar has after the core ended, in Node (`golden.json`: the `ended` record of any case, less the core's
/// own `daemonExit` block, which only the core writes).
fn node_keys() -> Vec<String> {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/crash-capture/golden.json")).unwrap();
    let ended = golden["cases"][0]["ended"].as_object().unwrap();
    ended.keys().filter(|key| *key != "daemonExit").cloned().collect()
}

#[tokio::test]
async fn a_core_is_started_once_and_the_next_launcher_attaches_to_it() {
    let world = World::new();
    let first = ensure_core(world.options("serve")).await.expect("first launcher");
    assert_eq!((first.core.state.as_str(), first.core.rpc.as_ref().map(|rpc| rpc.port)), ("serving", Some(4242)));
    let second = ensure_core(world.options("serve")).await.expect("second launcher");
    assert_eq!(second.pid, first.pid, "attached to the core that serves");

    let sidecars = world.sidecars();
    assert_eq!(sidecars.len(), 1, "one boot, one capture");
    let sidecar = record(&sidecars[0]);
    assert_eq!((sidecar["pid"].as_u64(), sidecar["ready"].as_bool(), sidecar["launcher"].as_str(), sidecar["detached"].as_bool()), (Some(u64::from(first.pid)), Some(true), Some("core"), Some(true)));
    assert!(sidecar["exitedAt"].is_null(), "the core still serves");

    world.stop(first.pid);
    // The launcher is alive, so it sees the exit and closes the sidecar: a clean end.
    until("the exit is recorded", || !record(&sidecars[0])["exitedAt"].is_null());
    let ended = record(&sidecars[0]);
    assert_eq!((ended["exitCode"].as_i64(), ended["exitReason"].as_str()), (Some(0), Some("exited normally (code 0)")));
}

#[tokio::test]
async fn two_launchers_racing_for_one_core_both_attach_to_the_winner() {
    let world = World::new();
    let (a, b) = tokio::join!(ensure_core(world.options("serve")), ensure_core(world.options("serve")));
    let (a, b) = (a.expect("launcher a"), b.expect("launcher b"));
    assert_eq!(a.pid, b.pid);
    // Two cores were started; the one that lost the claim ended cleanly with nothing to say, and its capture was dropped.
    until("the loser's capture is dropped", || world.sidecars().len() == 1);
    assert_eq!(record(&world.sidecars()[0])["pid"].as_u64(), Some(u64::from(a.pid)));
    world.stop(a.pid);
}

#[tokio::test]
async fn a_core_that_panics_before_serving_fails_the_launcher_with_what_it_said_and_leaves_its_capture() {
    let world = World::new();
    let error = ensure_core(world.options("crash-before-serving")).await.expect_err("the core ends before serving");
    let EnsureError::EndedBeforeServing { said, code, stderr_path, .. } = &error else { panic!("not an end before serving: {error}") };
    assert_eq!(*code, Some(101));
    assert!(said.as_deref().is_some_and(|said| said.contains("panicked")), "said: {said:?}");
    assert!(error.to_string().starts_with("core is not ready: the core ended before serving ("), "{error}");

    let capture = stderr_path.clone().expect("the capture file is kept");
    assert!(std::fs::read_to_string(&capture).unwrap().contains("the core lost its store"));
    let sidecars = world.sidecars();
    assert_eq!(sidecars.len(), 1);
    let sidecar = record(&sidecars[0]);
    assert_eq!((sidecar["ready"].as_bool(), sidecar["exitCode"].as_i64()), (Some(false), Some(101)));
    assert!(sidecar["stderrBytes"].as_u64().is_some_and(|bytes| bytes > 0));
}

#[tokio::test]
async fn a_core_that_ends_after_serving_leaves_a_sidecar_of_the_shape_node_writes() {
    let world = World::new();
    let found = ensure_core(world.options("crash-after-serving")).await.expect("serving");
    let sidecars = world.sidecars();
    assert_eq!(sidecars.len(), 1);
    until("the exit is recorded", || !record(&sidecars[0])["exitedAt"].is_null());
    let ended = record(&sidecars[0]);
    assert_eq!((ended["pid"].as_u64(), ended["ready"].as_bool(), ended["exitCode"].as_i64()), (Some(u64::from(found.pid)), Some(true), Some(7)));
    assert_eq!(ended["exitReason"].as_str(), Some("exited with code 7"));
    assert!(ended["uptimeMs"].as_i64().is_some_and(|ms| ms >= 0));

    let mut have: Vec<&String> = ended.as_object().unwrap().keys().collect();
    let mut want = node_keys();
    have.sort();
    want.sort();
    assert_eq!(have, want.iter().collect::<Vec<_>>(), "the same keys as Node's sidecar");
}

#[tokio::test]
async fn a_binary_that_cannot_start_is_a_start_error_with_a_terminal_sidecar() {
    let world = World::new();
    let mut options = world.options("serve");
    options.bin = Some(world.runtime.join("no-such-core"));
    let error = ensure_core(options).await.expect_err("nothing to start");
    assert!(matches!(error, EnsureError::Spawn { .. }), "{error}");
    assert!(error.to_string().starts_with("cannot start "), "{error}");
    let sidecars = world.sidecars();
    assert_eq!(sidecars.len(), 1);
    let sidecar = record(&sidecars[0]);
    assert!(sidecar["error"].as_str().is_some_and(|text| !text.is_empty()));
    assert!(!sidecar["exitedAt"].is_null(), "a launch that never had a child is not in progress");
    assert!(sidecar["pid"].is_null() && sidecar["stderrFile"].is_null());
}
