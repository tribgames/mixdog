use std::path::Path;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use serde_json::Value;
use serde_json::json;

use super::*;

const CHILD: &str = "MIXDOG_TEST_CRASH_RECORD_CHILD";

fn record(file: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(file).expect("the sidecar")).expect("json")
}

/// The core side of a boot the test launches: once the launcher's sidecar names this process (the gate file), the
/// recorder is installed as `serve` installs it and `serve` panics on the main path.
#[test]
fn crash_child() {
    let Some(data) = std::env::var_os(CHILD) else { return };
    let data = PathBuf::from(data);
    let deadline = Instant::now() + Duration::from_secs(20);
    while !data.join("gate").exists() {
        assert!(Instant::now() < deadline, "the launcher never opened the gate");
        std::thread::sleep(Duration::from_millis(10));
    }
    install(&data, &|pid| crate::verdict::ProcessTable::query(&crate::verdict::OsProcessTable, u64::from(pid)).is_ok_and(|info| info.is_some()));
    let code = serve_recorded(|| -> Result<(), String> { panic!("the core lost its store") });
    std::process::exit(code);
}

/// `daemon-crash-capture.test.mjs` "a daemon that dies after ready leaves its fd 2 text and exit code on disk", with the
/// launcher gone (nobody fills the exit for it): the core that panics leaves the reason, the panic's message and place,
/// and its exit code in its own sidecar, and its fd 2 file holds the panic line; a lost earlier boot is settled.
#[test]
fn a_core_that_panics_leaves_its_reason_and_exit_code_in_its_sidecar() {
    let data = tempfile::tempdir().unwrap();
    let dir = capture_dir(data.path());
    std::fs::create_dir_all(&dir).unwrap();
    // An earlier boot whose core is gone and recorded nothing, and one that exited normally.
    let lost = dir.join("daemon-20260915-064800-999999998-aaaa.json");
    std::fs::write(&lost, json!({ "kind": "mixdog-daemon-crash-capture", "pid": 999_999_999, "launcherPid": 999_999_998, "exitedAt": null }).to_string()).unwrap();
    let done = dir.join("daemon-20260915-064700-999999998-bbbb.json");
    let done_record = json!({ "kind": "mixdog-daemon-crash-capture", "pid": 999_999_997, "exitedAt": "2026-09-15T06:47:30.000Z", "exitCode": 0 });
    std::fs::write(&done, done_record.to_string()).unwrap();

    // The launcher: fd 2 in the capture file, then the sidecar naming the child (`spawn-capture.mjs` `track`).
    let stem = "daemon-20261111-041500-4242-c0de";
    let err_log = dir.join(format!("{stem}.err.log"));
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["crash_record::tests::crash_child", "--exact", "--nocapture", "--test-threads=1"])
        .env(CHILD, data.path())
        .env("RUST_BACKTRACE", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(&err_log).unwrap())
        .spawn()
        .unwrap();
    let sidecar = dir.join(format!("{stem}.json"));
    let launched = json!({
        "kind": "mixdog-daemon-crash-capture", "launcher": "test", "launcherPid": 4242, "pid": child.id(), "detached": true,
        "heapFlags": [], "stderrFile": format!("{stem}.err.log"), "spawnedAt": "2026-11-11T04:15:00.000Z",
        "readyAt": "2026-11-11T04:15:01.000Z", "exitedAt": null, "ready": true, "exitCode": null, "exitSignal": null,
        "uptimeMs": null, "stderrBytes": 0, "error": null,
    });
    std::fs::write(&sidecar, launched.to_string()).unwrap();
    std::fs::write(data.path().join("gate"), "go").unwrap();
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(PANIC_EXIT_CODE), "the core ends as a panicked main thread does");

    let written = record(&sidecar);
    let exit = &written["daemonExit"];
    assert_eq!(exit["reason"], "fatal panic (exited with code 101)");
    assert_eq!(exit["code"], 101);
    assert_eq!(exit["signal"], Value::Null);
    let error = exit["error"].as_str().expect("the panic");
    assert!(error.starts_with("panicked at "), "{error}");
    assert!(error.contains("crash_record_tests.rs:"), "the panic's place: {error}");
    assert!(error.contains(": the core lost its store (thread "), "{error}");
    assert!(exit["uptimeMs"].as_i64().is_some_and(|ms| ms >= 0));
    // The launcher never saw the exit: its fields are the core's, and the rest of its document stands.
    assert_eq!(written["exitedAt"], exit["at"]);
    assert_eq!(written["exitCode"], 101);
    assert_eq!(written["exitSignal"], Value::Null);
    assert_eq!(written["exitReason"], exit["reason"]);
    for key in ["kind", "launcher", "launcherPid", "pid", "stderrFile", "spawnedAt", "readyAt", "ready"] {
        assert_eq!(written[key], launched[key], "{key}");
    }
    // fd 2 holds the panic line.
    let captured = std::fs::read_to_string(&err_log).unwrap();
    assert!(captured.contains("the core lost its store"), "{captured}");

    // The lost boot is settled; the one that recorded its exit is not touched.
    let lost = record(&lost);
    assert!(lost["exitReason"].as_str().is_some_and(|r| r.starts_with("unrecorded-termination: ")), "{lost}");
    assert!(lost["exitReconciledAt"].is_string());
    assert_eq!(record(&done), done_record);
}

#[test]
fn an_exit_is_described_as_node_describes_it() {
    assert_eq!(describe_exit(Some(0)), "exited normally (code 0)");
    assert_eq!(describe_exit(Some(7)), "exited with code 7");
    assert_eq!(describe_exit(Some(0xC000_013Au32 as i32)), "terminated by Ctrl+C / console close (STATUS_CONTROL_C_EXIT 0xC000013A)");
    assert_eq!(describe_exit(None), "exit not observed");
    assert!(is_capture_record("daemon-20260915-064900-123-0a9f.json"));
    assert!(!is_capture_record("daemon-20260915-064900-123-0a9f.err.log"));
    assert!(!is_capture_record("daemon-2026091-064900-123-0a9f.json"));
}
