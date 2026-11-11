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
/// The recording's texts (`record-crash-capture.mjs` `MESSAGE`, `BOOT_ERROR`).
const MESSAGE: &str = "the core lost its store";
const BOOT_ERROR: &str = "the data folder is held by another core";

/// `fixtures/crash-capture` (record-crash-capture.mjs): Node's sidecars per end, launcher gone.
fn golden_case(name: &str) -> Value {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/crash-capture/golden.json")).expect("golden");
    assert_eq!((golden["message"].as_str(), golden["bootError"].as_str()), (Some(MESSAGE), Some(BOOT_ERROR)));
    golden["cases"].as_array().unwrap().iter().find(|case| case["name"] == name).cloned().unwrap_or_else(|| panic!("no case {name}"))
}

fn record(file: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(file).expect("the sidecar")).expect("json")
}

/// The core side of a boot the test launches. It waits for the launcher's `go` line on stdin (the sidecar naming this
/// process is written), installs the recorder as `serve` installs it, then ends the way its scenario names:
/// `main-panic` (a panic unwinds out of `serve`), `fatal-error` (`serve` returns an error), `exit-code` (the process
/// exits 3 with no reason stated), `killed` (waits for a line that never comes; the test ends it from outside),
/// `stack-overflow` and `oom` (aborts that run no hook), `caught-panic` (a worker thread panics and is joined; the core
/// says `caught` on stdout, waits for `stop`, and stops as the release procedure stops it), `next-boot` (a later core:
/// it installs, which settles the earlier boots, and exits).
#[test]
fn crash_child() {
    let Some(data) = std::env::var_os(CHILD) else { return };
    let scenario = std::env::var(SCENARIO).expect("a scenario");
    let mut lines = std::io::stdin().lock().lines();
    let mut expect = |line: &str| assert_eq!(lines.next().expect("the launcher's line").expect("stdin"), line);
    if scenario != "next-boot" {
        expect("go");
    }
    install(Path::new(&data), &|pid| crate::verdict::ProcessTable::query(&crate::verdict::OsProcessTable, u64::from(pid)).is_ok_and(|info| info.is_some()));
    let code = match scenario.as_str() {
        // On a thread named as the process's main thread is, whatever thread the test harness runs this on.
        "main-panic" => std::thread::Builder::new()
            .name("main".into())
            .spawn(|| serve_recorded(|| -> Result<(), String> { panic!("{}", MESSAGE) }))
            .unwrap()
            .join()
            .unwrap(),
        "fatal-error" => serve_recorded(|| -> Result<(), String> { Err(BOOT_ERROR.into()) }),
        "exit-code" => {
            record_exit(3);
            3
        }
        "killed" => {
            expect("never");
            0
        }
        "stack-overflow" => {
            fn deeper(n: u64) -> u64 {
                let frame = [n; 512];
                std::hint::black_box(&frame);
                deeper(n + 1) + frame[0]
            }
            std::thread::Builder::new().stack_size(64 * 1024).spawn(|| deeper(0)).unwrap().join().map_or(1, |_| 0)
        }
        "oom" => std::alloc::handle_alloc_error(std::alloc::Layout::from_size_align(1 << 40, 8).unwrap()),
        "next-boot" => 0,
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
    /// A boot ending as `scenario`, its sidecar the one Node's launcher left in `case` of the recording. With
    /// `dead_pipe` its fd 2 is a pipe whose reader is gone before the core does anything (a fallback pipe of a launcher
    /// that has exited), not the capture file.
    fn start(data: &Path, stem: &str, scenario: &str, case: &str, dead_pipe: bool) -> Self {
        let dir = capture_dir(data);
        std::fs::create_dir_all(&dir).unwrap();
        let err_log = dir.join(format!("{stem}.err.log"));
        let stderr = std::fs::File::create(&err_log).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["crash_record::tests::crash_child", "--exact", "--nocapture", "--test-threads=1", "-q"])
            .env(CHILD, data)
            .env(SCENARIO, scenario)
            .env("RUST_BACKTRACE", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if dead_pipe { Stdio::piped() } else { stderr.into() })
            .spawn()
            .unwrap();
        drop(child.stderr.take());
        let (tx, said) = mpsc::channel();
        let stdout = child.stdout.take().unwrap();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
        let sidecar = dir.join(format!("{stem}.json"));
        // Node's launcher's sidecar with this boot's ids and times; its launcher is gone.
        let mut launched = golden_case(case)["launched"].clone();
        for (key, value) in [
            ("pid", json!(child.id())),
            ("launcherPid", json!(999_999_998)),
            ("stderrFile", json!(format!("{stem}.err.log"))),
            ("spawnedAt", json!("2026-11-11T04:15:00.000Z")),
            ("readyAt", json!("2026-11-11T04:15:01.000Z")),
        ] {
            let placeholder = if key == "stderrFile" { "<stem>.err.log".to_owned() } else { format!("<{key}>") };
            assert_eq!(launched[key], json!(placeholder), "the recording's {key}");
            launched[key] = value;
        }
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

    /// Waits for the child to end; its exit code (none when a signal ended it).
    fn ended(self) -> (Option<i32>, Value, String) {
        let mut child = self.child;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait().map(|status| status.code()));
        });
        let code = rx.recv_timeout(DEADLINE).expect("timed out waiting for the core to end").unwrap();
        (code, record(&self.sidecar), std::fs::read_to_string(&self.err_log).unwrap())
    }
}

/// The sidecar as the recorder keeps it (`record-crash-capture.mjs` `steady`): ids, times, uptime, memory and the stem as
/// placeholders, and the error as its message. A JS error is its stack (`Error: <message> at …`), a panic its text
/// (`panicked at <place>: <message> (thread <name>)`); the message is what both carry.
fn steady(mut record: Value) -> Value {
    let set = |v: &Value| !v.is_null() && v != &json!(0) && v != &json!("") && v != &json!(false);
    for key in ["spawnedAt", "readyAt", "exitedAt", "exitReconciledAt", "pid", "launcherPid", "stderrBytes"] {
        if record.get(key).is_some_and(set) {
            record[key] = json!(format!("<{key}>"));
        }
    }
    if record.get("stderrFile").is_some_and(set) {
        record["stderrFile"] = json!("<stem>.err.log");
    }
    if record.get("uptimeMs").is_some_and(Value::is_i64) {
        record["uptimeMs"] = json!("<uptimeMs>");
    }
    if let Some(exit) = record.get_mut("daemonExit").and_then(Value::as_object_mut) {
        assert!(exit.get("at").is_some_and(Value::is_string), "the exit's time: {exit:?}");
        exit.insert("at".into(), json!("<at>"));
        for key in ["uptimeMs", "rssBytes", "heapUsedBytes"] {
            assert!(exit.get(key).is_some_and(Value::is_u64), "the exit's {key}: {exit:?}");
            exit.insert(key.into(), json!(format!("<{key}>")));
        }
        if let Some(error) = exit.get("error").and_then(Value::as_str) {
            let message = error.split_once(": ").map_or(error, |(_, rest)| rest);
            let message = message.rsplit_once(" (thread ").map_or(message, |(message, _)| message);
            exit.insert("error".into(), json!(message));
        }
    }
    record
}

/// A later core starting on the same data folder: it settles the boots that ended without a record.
fn next_boot(data: &Path) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["crash_record::tests::crash_child", "--exact", "--nocapture", "--test-threads=1", "-q"])
        .env(CHILD, data)
        .env(SCENARIO, "next-boot")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait());
    });
    assert!(rx.recv_timeout(DEADLINE).expect("timed out waiting for the next core").unwrap().success());
}

/// One end of the recording replayed: a boot ends as `scenario` (killed from outside for `killed`), the next core starts
/// when Node's did, and the sidecar is Node's. Answers the exit code and the fd 2 text.
fn replay(case: &str, scenario: &str, dead_pipe: bool) -> (Option<i32>, String) {
    let data = tempfile::tempdir().unwrap();
    let golden = golden_case(case);
    let mut boot = Boot::start(data.path(), "daemon-20261111-041500-999999998-c0de", scenario, case, dead_pipe);
    assert_eq!(steady(boot.launched.clone()), golden["launched"], "{case}: the launcher's sidecar");
    if scenario == "killed" {
        boot.child.kill().unwrap();
    }
    let (code, _, captured) = boot.ended();
    if golden["settledByNextBoot"] == json!(1) {
        next_boot(data.path());
    }
    assert_eq!(steady(record(&boot_sidecar(data.path()))), golden["ended"], "{case} ({scenario}): the sidecar at the end");
    (code, captured)
}

fn boot_sidecar(data: &Path) -> PathBuf {
    capture_dir(data).join("daemon-20261111-041500-999999998-c0de.json")
}

/// Node's uncaught exception (`uncaughtExceptionMonitor`, `onFatalError`, `settleExit`, the exit hook), launcher gone: a
/// panic out of `serve` leaves the same sidecar, the process exits 1 as Node's does, and fd 2 (the capture file) holds
/// the panic line.
#[test]
fn a_core_that_panics_leaves_nodes_uncaught_exception_record() {
    let (code, captured) = replay("uncaught", "main-panic", false);
    assert_eq!(code, Some(PANIC_EXIT_CODE));
    assert!(captured.contains(MESSAGE), "fd 2 holds the panic line: {captured}");
}

/// `serve` returning an error is Node's `main().catch` → `shutdown('fatal boot error', 2)`.
#[test]
fn a_serve_error_leaves_nodes_fatal_boot_error_record() {
    let (code, captured) = replay("fatal-boot", "fatal-error", false);
    assert_eq!(code, Some(2));
    assert!(captured.contains(&format!("mixdogd: {BOOT_ERROR}")), "{captured}");
}

/// An exit with no stated reason records its code alone.
#[test]
fn an_exit_with_no_reason_leaves_nodes_record_of_its_code() {
    assert_eq!(replay("exit-code", "exit-code", false).0, Some(3));
}

/// A core killed from outside runs nothing; the next core settles its boot as Node's next daemon does.
#[test]
fn a_killed_core_is_settled_by_the_next_core_as_node_settles_it() {
    replay("killed", "killed", false);
}

/// An abort that runs no hook — Node's heap-out-of-memory abort; here a stack overflow and an allocation failure, both
/// ending the process without a panic — leaves nothing of its own; the next core settles the boot the same way.
#[test]
fn an_abort_that_runs_no_hook_is_settled_by_the_next_core_as_nodes_out_of_memory_is() {
    for scenario in ["stack-overflow", "oom"] {
        let (code, _) = replay("oom", scenario, false);
        assert_ne!(code, Some(0), "{scenario} ends the process abnormally");
    }
}

/// The launcher gone with its fallback stderr pipe (the read end closed before the core writes): a write to fd 2 fails
/// and is dropped, so the core still ends as recorded; nothing blocks or replaces the end's record.
#[test]
fn a_dead_launchers_stderr_pipe_neither_blocks_nor_replaces_the_record() {
    let (code, captured) = replay("fatal-boot", "fatal-error", true);
    assert_eq!(code, Some(2));
    assert!(captured.is_empty(), "nothing reached the capture file: {captured}");
}

/// A panic on a worker thread that the runtime catches is in the boot's record when it happens, as Node's
/// `uncaughtExceptionMonitor` write is; the normal stop that follows names it (`settleExit` after a fatal error) with the
/// code the stop exits with. Node's process ends at such an error, so the record after the stop has no recording.
#[test]
fn a_caught_worker_panic_is_in_the_record_when_it_happens_and_the_stop_after_it_names_it() {
    let data = tempfile::tempdir().unwrap();
    let mut boot = Boot::start(data.path(), "daemon-20261111-041600-999999998-0bad", "caught-panic", "uncaught", false);
    boot.heard("caught");
    let mut at_panic = golden_case("uncaught")["ended"].clone();
    at_panic["daemonExit"]["reason"] = json!("fatal uncaughtException");
    at_panic["daemonExit"]["error"] = json!("a worker lost its job");
    assert_eq!(steady(record(&boot.sidecar)), at_panic, "the record while the core still runs");
    boot.say("stop");
    let (code, written, _) = boot.ended();
    assert_eq!(code, Some(0));
    let mut stopped = at_panic;
    stopped["exitCode"] = json!(0);
    stopped["daemonExit"]["code"] = json!(0);
    stopped["daemonExit"]["reason"] = json!("shutdown: no live session clients (fatal uncaught exception) (exited normally (code 0))");
    assert_eq!(steady(written), stopped, "the record after the stop");
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
