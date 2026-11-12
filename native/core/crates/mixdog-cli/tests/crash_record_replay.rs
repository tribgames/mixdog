//! The crash record of `mixdogd serve`, replayed from Node's recording (`fixtures/crash-capture`,
//! `record-crash-capture.mjs`) through the real binary's start-up: each end of the process (an uncaught exception, a fatal
//! boot error, an exit with no stated reason, a kill, an abort that runs no hook, a panic a worker thread has caught) is a
//! start of `mixdogd serve` that a launcher names with its sidecar first (`spawn-capture.mjs` `track`), the sidecar left at
//! the end compared with Node's whole. The binary's own recorder install is what writes it (`crash_record::install_for_process`,
//! before the JS runtime or the executors are looked at), and one end is the start-up failing on its own (no JS runtime beside
//! the binary), with no fault added. The faults are `boot_fault.rs`, compiled into a `crash-gates` build.
//!
//! Windows only, as the recording is: the binary's console is its own and has no window.
#![cfg(windows)]
#![allow(clippy::disallowed_methods, reason = "the test lays out an install, runs a process and reads what it left on disk")]

use std::io::BufRead;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

use mixdog_app_server_daemon::crash_record::PANIC_EXIT_CODE;
use mixdog_app_server_daemon::crash_record::capture_dir;
use serde_json::Value;
use serde_json::json;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Every wait of these tests: a start that runs a few lines of code and ends.
const DEADLINE: Duration = Duration::from_secs(120);
const STEM: &str = "daemon-20261111-041500-999999998-c0de";

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/crash-capture/golden.json")).expect("golden")
}

/// Node's sidecars per end, launcher gone.
fn golden_case(name: &str) -> Value {
    golden()["cases"].as_array().unwrap().iter().find(|case| case["name"] == name).cloned().unwrap_or_else(|| panic!("no case {name}"))
}

fn record(file: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(file).expect("the sidecar")).expect("json")
}

fn terminate(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;
    use windows_sys::Win32::System::Threading::TerminateProcess;
    // SAFETY: the handle is checked and closed.
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

/// The binary under test, hard-linked into a folder of its own with no `js-runtime.json` beside it.
fn binary() -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("crash-record-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let exe = dir.join("mixdogd.exe");
    std::fs::hard_link(env!("CARGO_BIN_EXE_mixdogd"), &exe).unwrap();
    exe
}

fn command(exe: &Path, data: &Path, scenario: &str, text: &str) -> Command {
    let mut command = Command::new(exe);
    command
        .arg("serve")
        .env_clear()
        .env("SystemRoot", std::env::var("SystemRoot").unwrap())
        .env("PATH", std::env::var("PATH").unwrap())
        .env("TEMP", data)
        .env("TMP", data)
        .env("MIXDOG_DATA_DIR", data)
        .env("MIXDOG_TEST_BOOT_FAULT", scenario)
        .env("MIXDOG_TEST_BOOT_FAULT_TEXT", text)
        .env("RUST_BACKTRACE", "0")
        .creation_flags(CREATE_NO_WINDOW);
    command
}

/// A start of `mixdogd serve` with fd 2 in its capture file and the launcher's sidecar naming it: what it says on stdout
/// arrives as lines, and its end is an event.
struct Boot {
    child: Option<std::process::Child>,
    pid: u32,
    sidecar: PathBuf,
    err_log: PathBuf,
    launched: Value,
    said: mpsc::Receiver<String>,
    ended: bool,
}

impl Drop for Boot {
    fn drop(&mut self) {
        if !self.ended {
            terminate(self.pid);
        }
    }
}

impl Boot {
    /// A start ending as `scenario`, its sidecar the one Node's launcher left in `case` of the recording. With `dead_pipe` its
    /// fd 2 is a pipe whose reader is gone before the core does anything (a fallback pipe of a launcher that has exited), not
    /// the capture file.
    fn start(exe: &Path, data: &Path, stem: &str, scenario: &str, case: &str, dead_pipe: bool) -> Self {
        let dir = capture_dir(data);
        std::fs::create_dir_all(&dir).unwrap();
        let err_log = dir.join(format!("{stem}.err.log"));
        let stderr = std::fs::File::create(&err_log).unwrap();
        let text = golden()[if scenario == "main-panic" || scenario == "caught-panic" { "message" } else { "bootError" }].as_str().unwrap().to_owned();
        let mut child = command(exe, data, scenario, &text)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if dead_pipe { Stdio::piped() } else { stderr.into() })
            .spawn()
            .unwrap();
        let pid = child.id();
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
            ("pid", json!(pid)),
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
        let mut boot = Self { child: Some(child), pid, sidecar, err_log, launched, said, ended: false };
        boot.say("go");
        boot
    }

    fn say(&mut self, line: &str) {
        writeln!(self.child.as_mut().unwrap().stdin.as_mut().unwrap(), "{line}").unwrap();
    }

    /// Waits for the process to say `line`.
    fn heard(&self, line: &str) {
        loop {
            match self.said.recv_timeout(DEADLINE) {
                Ok(said) if said == line => return,
                Ok(_) => {}
                Err(_) => panic!("timed out after {DEADLINE:?} waiting for the core to say {line:?}"),
            }
        }
    }

    /// Ends the process from outside (a kill, which runs nothing of its own).
    fn kill(&mut self) {
        terminate(self.pid);
    }

    /// Waits for the process to end: its exit code (none when a signal ended it), its sidecar and its fd 2 text.
    fn ended(mut self) -> (Option<i32>, Value, String) {
        let mut child = self.child.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait().map(|status| status.code()));
        });
        let code = rx.recv_timeout(DEADLINE).unwrap_or_else(|_| panic!("timed out after {DEADLINE:?} waiting for the core to end")).unwrap();
        self.ended = true;
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

/// A later core starting on the same data folder (`next-boot`: its recorder install settles the earlier boots, then it ends).
fn next_boot(exe: &Path, data: &Path) {
    let mut child = command(exe, data, "next-boot", "").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait());
    });
    let ended = rx.recv_timeout(DEADLINE).unwrap_or_else(|_| {
        terminate(pid);
        panic!("timed out after {DEADLINE:?} waiting for the next core to end")
    });
    assert!(ended.unwrap().success());
}

/// One end of the recording replayed: a start ends as `scenario` (killed from outside for `killed`), the next core starts
/// when Node's did, and the sidecar is Node's. Answers the exit code and the fd 2 text.
fn replay(case: &str, scenario: &str, dead_pipe: bool) -> (Option<i32>, String) {
    let exe = binary();
    let data = tempfile::tempdir().unwrap();
    let golden = golden_case(case);
    let mut boot = Boot::start(&exe, data.path(), STEM, scenario, case, dead_pipe);
    assert_eq!(steady(boot.launched.clone()), golden["launched"], "{case}: the launcher's sidecar");
    if scenario == "killed" {
        boot.heard("installed");
        boot.kill();
    }
    let (code, _, captured) = boot.ended();
    if golden["settledByNextBoot"] == json!(1) {
        next_boot(&exe, data.path());
    }
    assert_eq!(steady(record(&capture_dir(data.path()).join(format!("{STEM}.json")))), golden["ended"], "{case} ({scenario}): the sidecar at the end");
    (code, captured)
}

/// Node's uncaught exception (`uncaughtExceptionMonitor`, `onFatalError`, `settleExit`, the exit hook), launcher gone: a
/// panic out of the start is the same sidecar, the process exits 1 as Node's does, and fd 2 (the capture file) holds the
/// panic line.
#[test]
fn a_core_that_panics_leaves_nodes_uncaught_exception_record() {
    let (code, captured) = replay("uncaught", "main-panic", false);
    assert_eq!(code, Some(PANIC_EXIT_CODE));
    assert!(captured.contains(golden()["message"].as_str().unwrap()), "fd 2 holds the panic line: {captured}");
}

/// A start returning an error is Node's `main().catch` → `shutdown('fatal boot error', 2)`.
#[test]
fn a_start_error_leaves_nodes_fatal_boot_error_record() {
    let (code, captured) = replay("fatal-boot", "fatal-error", false);
    assert_eq!(code, Some(2));
    assert!(captured.contains(&format!("mixdogd: {}", golden()["bootError"].as_str().unwrap())), "{captured}");
}

/// The start-up failing on its own, before the JS runtime is resolved: no `js-runtime.json` stands beside the binary, so
/// resolving it is the first thing that fails. Node installs its recorder at module load and so records it; the core's
/// recorder is installed before that step as well.
#[test]
fn a_start_that_fails_before_the_runtime_is_resolved_still_leaves_the_fatal_boot_error_record() {
    let (code, captured) = replay("fatal-boot", "real", false);
    assert_eq!(code, Some(2));
    assert!(captured.contains("mixdogd: resolving the JS runtime"), "{captured}");
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
    let exe = binary();
    let data = tempfile::tempdir().unwrap();
    let mut boot = Boot::start(&exe, data.path(), "daemon-20261111-041600-999999998-0bad", "caught-panic", "uncaught", false);
    boot.heard("caught");
    let mut at_panic = golden_case("uncaught")["ended"].clone();
    at_panic["daemonExit"]["reason"] = json!("fatal uncaughtException");
    at_panic["daemonExit"]["error"] = json!("the core lost its store");
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
