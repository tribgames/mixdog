use std::io::BufRead;
use std::path::Path;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::Value;
use serde_json::json;

use super::*;

const CHILD: &str = "MIXDOG_TEST_CRASH_RECORD_CHILD";
const SCENARIO: &str = "MIXDOG_TEST_CRASH_RECORD_SCENARIO";
/// Every wait of these tests: a child that runs a few lines of code and ends.
const DEADLINE: Duration = Duration::from_secs(60);

fn record(file: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(file).expect("the sidecar")).expect("json")
}

/// The core side of a boot the test launches. It waits for the launcher's `go` line on stdin (the sidecar naming this
/// process is written), installs the recorder as `serve` installs it, then ends the way its scenario names:
/// `main-panic` (a panic unwinds out of `serve`), `fatal-error` (`serve` returns an error), `caught-panic` (a worker
/// thread panics and is joined; the core says `caught` on stdout, waits for `stop`, and stops as the release procedure
/// stops it).
#[test]
fn crash_child() {
    let Some(data) = std::env::var_os(CHILD) else { return };
    let scenario = std::env::var(SCENARIO).expect("a scenario");
    let mut lines = std::io::stdin().lock().lines();
    let mut expect = |line: &str| assert_eq!(lines.next().expect("the launcher's line").expect("stdin"), line);
    expect("go");
    install(Path::new(&data), &|pid| crate::verdict::ProcessTable::query(&crate::verdict::OsProcessTable, u64::from(pid)).is_ok_and(|info| info.is_some()));
    let code = match scenario.as_str() {
        // On a thread named as the process's main thread is, whatever thread the test harness runs this on.
        "main-panic" => std::thread::Builder::new()
            .name("main".into())
            .spawn(|| serve_recorded(|| -> Result<(), String> { panic!("the core lost its store") }))
            .unwrap()
            .join()
            .unwrap(),
        "fatal-error" => serve_recorded(|| -> Result<(), String> { Err("the data folder is held by another core".into()) }),
        "caught-panic" => {
            let worker = std::thread::Builder::new().name("worker".into()).spawn(|| panic!("a worker lost its job")).unwrap();
            assert!(worker.join().is_err(), "the worker panicked");
            println!("caught");
            std::io::stdout().flush().unwrap();
            expect("stop");
            let code = settle_exit("no live session clients", 0);
            record_exit(code);
            code
        }
        other => panic!("no scenario {other}"),
    };
    std::process::exit(code);
}

/// A boot of `crash_child` with fd 2 in its capture file and the launcher's sidecar naming it (`spawn-capture.mjs`
/// `track`): what it says on stdout arrives as lines, and its end is an event.
struct Boot {
    child: std::process::Child,
    sidecar: PathBuf,
    err_log: PathBuf,
    launched: Value,
    said: mpsc::Receiver<String>,
}

impl Boot {
    fn start(data: &Path, stem: &str, scenario: &str) -> Self {
        let dir = capture_dir(data);
        let err_log = dir.join(format!("{stem}.err.log"));
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["crash_record::tests::crash_child", "--exact", "--nocapture", "--test-threads=1", "-q"])
            .env(CHILD, data)
            .env(SCENARIO, scenario)
            .env("RUST_BACKTRACE", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(std::fs::File::create(&err_log).unwrap())
            .spawn()
            .unwrap();
        let (tx, said) = mpsc::channel();
        let stdout = child.stdout.take().unwrap();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
        let sidecar = dir.join(format!("{stem}.json"));
        let launched = json!({
            "kind": "mixdog-daemon-crash-capture", "launcher": "test", "launcherPid": 4242, "pid": child.id(), "detached": true,
            "heapFlags": [], "stderrFile": format!("{stem}.err.log"), "spawnedAt": "2026-11-11T04:15:00.000Z",
            "readyAt": "2026-11-11T04:15:01.000Z", "exitedAt": null, "ready": true, "exitCode": null, "exitSignal": null,
            "uptimeMs": null, "stderrBytes": 0, "error": null,
        });
        std::fs::write(&sidecar, launched.to_string()).unwrap();
        let mut boot = Self { child, sidecar, err_log, launched, said };
        boot.say("go");
        boot
    }

    fn say(&mut self, line: &str) {
        writeln!(self.child.stdin.as_mut().unwrap(), "{line}").unwrap();
    }

    /// Waits for the child to say `line`.
    fn heard(&self, line: &str) {
        loop {
            match self.said.recv_timeout(DEADLINE) {
                Ok(said) if said == line => return,
                Ok(_) => {}
                Err(_) => panic!("timed out waiting for the core to say {line:?}"),
            }
        }
    }

    /// Waits for the child to end; its exit code.
    fn ended(self) -> (i32, Value, String) {
        let mut child = self.child;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait().map(|status| status.code()));
        });
        let code = rx.recv_timeout(DEADLINE).expect("timed out waiting for the core to end").unwrap().expect("an exit code");
        (code, record(&self.sidecar), std::fs::read_to_string(&self.err_log).unwrap())
    }
}

/// The sidecar with what differs per run (the times the core stamps, its uptime and the place a panic names) set aside.
fn steady(mut record: Value) -> Value {
    for (holder, key) in [(None, "exitedAt"), (None, "uptimeMs"), (Some("daemonExit"), "at"), (Some("daemonExit"), "uptimeMs")] {
        let target = match holder {
            Some(holder) => &mut record[holder],
            None => &mut record,
        };
        if target.get(key).is_some_and(|value| !value.is_null()) {
            target[key] = json!(format!("<{key}>"));
        }
    }
    if let Some(error) = record["daemonExit"]["error"].as_str() {
        let place = error.find(" at ").zip(error.find(": ")).map(|(from, to)| error[from..to].to_owned());
        if let Some(place) = place {
            record["daemonExit"]["error"] = json!(error.replace(&place, " at <place>"));
        }
    }
    record
}

fn with(launched: &Value, fields: Value) -> Value {
    let mut out = launched.clone();
    out.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
    out
}

/// `daemon-crash-capture.test.mjs` "a daemon that dies after ready leaves its fd 2 text and exit code on disk", with the
/// launcher gone (nobody fills the exit for it): the core whose `serve` panics leaves Node's uncaught-exception record
/// (`uncaughtExceptionMonitor`, `onFatalError`, `settleExit`, the exit hook) with the panic's text, exits 1 as Node does, and
/// its fd 2 file holds the panic line; a lost earlier boot is settled.
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

    let boot = Boot::start(data.path(), "daemon-20261111-041500-4242-c0de", "main-panic");
    let launched = boot.launched.clone();
    let (code, written, captured) = boot.ended();
    assert_eq!(code, PANIC_EXIT_CODE, "the core ends as Node's daemon ends after an uncaught exception");
    let panic = "panicked at <place>: the core lost its store (thread main)";
    let expected = with(&launched, json!({
        "exitedAt": "<exitedAt>", "exitCode": 1, "exitSignal": null, "uptimeMs": "<uptimeMs>",
        "exitReason": "fatal uncaughtException",
        "daemonExit": {
            "reason": "shutdown: fatal uncaught exception (fatal uncaught exception) (exited with code 1)",
            "code": 1, "signal": null, "error": panic, "at": "<at>", "uptimeMs": "<uptimeMs>",
        },
    }));
    assert_eq!(steady(written), expected);
    assert!(captured.contains("the core lost its store"), "fd 2 holds the panic line: {captured}");

    // The lost boot is settled; the one that recorded its exit is not touched.
    let lost = record(&lost);
    assert!(lost["exitReason"].as_str().is_some_and(|r| r.starts_with("unrecorded-termination: ")), "{lost}");
    assert!(lost["exitReconciledAt"].is_string());
    assert_eq!(record(&done), done_record);
}

/// A panic on a worker thread that the runtime catches is in the boot's record when it happens, before any exit; the
/// normal stop that follows names it (`settleExit` after a fatal error) with the code the stop exits with.
#[test]
fn a_caught_worker_panic_is_in_the_record_when_it_happens_and_the_stop_after_it_names_it() {
    let data = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(capture_dir(data.path())).unwrap();
    let mut boot = Boot::start(data.path(), "daemon-20261111-041600-4242-0bad", "caught-panic");
    let launched = boot.launched.clone();
    boot.heard("caught");
    let panic = "panicked at <place>: a worker lost its job (thread worker)";
    let at_panic = with(&launched, json!({
        "exitedAt": "<exitedAt>", "exitCode": 1, "exitSignal": null, "uptimeMs": "<uptimeMs>",
        "exitReason": "fatal uncaughtException",
        "daemonExit": { "reason": "fatal uncaughtException", "code": 1, "signal": null, "error": panic, "at": "<at>", "uptimeMs": "<uptimeMs>" },
    }));
    assert_eq!(steady(record(&boot.sidecar)), at_panic, "the record while the core still runs");
    boot.say("stop");
    let (code, written, _) = boot.ended();
    assert_eq!(code, 0);
    let stopped = with(&launched, json!({
        "exitedAt": "<exitedAt>", "exitCode": 0, "exitSignal": null, "uptimeMs": "<uptimeMs>",
        "exitReason": "fatal uncaughtException",
        "daemonExit": {
            "reason": "shutdown: no live session clients (fatal uncaught exception) (exited normally (code 0))",
            "code": 0, "signal": null, "error": panic, "at": "<at>", "uptimeMs": "<uptimeMs>",
        },
    }));
    assert_eq!(steady(written), stopped, "the record after the stop");
}

/// `serve` returning an error is Node's `main().catch` → `shutdown('fatal boot error', 2)`.
#[test]
fn a_serve_error_is_nodes_fatal_boot_error() {
    let data = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(capture_dir(data.path())).unwrap();
    let boot = Boot::start(data.path(), "daemon-20261111-041700-4242-0e44", "fatal-error");
    let launched = boot.launched.clone();
    let (code, written, captured) = boot.ended();
    assert_eq!(code, 2);
    let expected = with(&launched, json!({
        "exitedAt": "<exitedAt>", "exitCode": 2, "exitSignal": null, "uptimeMs": "<uptimeMs>",
        "exitReason": "shutdown: fatal boot error (exited with code 2)",
        "daemonExit": { "reason": "shutdown: fatal boot error (exited with code 2)", "code": 2, "signal": null, "error": null, "at": "<at>", "uptimeMs": "<uptimeMs>" },
    }));
    assert_eq!(steady(written), expected);
    assert!(captured.contains("mixdogd: the data folder is held by another core"), "{captured}");
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
