//! The crash record of `mixdogd serve`, through the real binary's start-up: each end of the process (a panic out of the start, a
//! start error, an exit with no stated reason, a kill, an abort that runs no hook, a panic a worker thread has caught) is a
//! start of `mixdogd serve` that a launcher names with its sidecar first, and the sidecar left at the end says how the process
//! ended. The binary's own recorder install is what writes it (`crash_record::install_for_process`, before the JS runtime or
//! the executors are looked at), and one end is the start-up failing on its own (no JS runtime beside the binary), with no
//! fault added. The faults are `boot_fault.rs`, compiled into a `crash-gates` build.
//!
//! Windows only: the binary's console is its own and has no window.
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
const PANIC_MESSAGE: &str = "the core lost its store";
const BOOT_ERROR: &str = "the data folder is held by another core";
const UNRECORDED: &str = "unrecorded-termination: the daemon ended without running any exit hook and its launcher recorded no exit";

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

/// The binary under test, hard-linked into a folder of its own with no `js-runtime.json` beside it. The folder is removed
/// with the guard: a link left behind keeps every later build's old binary on disk.
fn binary() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new().prefix("crash-record-").tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let exe = dir.path().join("mixdogd.exe");
    std::fs::hard_link(env!("CARGO_BIN_EXE_mixdogd"), &exe).unwrap();
    (dir, exe)
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
    /// A start ending as `scenario`, its sidecar the one a launcher leaves when it has spawned the core and seen it ready. With
    /// `dead_pipe` its fd 2 is a pipe whose reader is gone before the core does anything (a fallback pipe of a launcher that
    /// has exited), not the capture file.
    fn start(exe: &Path, data: &Path, stem: &str, scenario: &str, text: &str, dead_pipe: bool) -> Self {
        let dir = capture_dir(data);
        std::fs::create_dir_all(&dir).unwrap();
        let err_log = dir.join(format!("{stem}.err.log"));
        let stderr = std::fs::File::create(&err_log).unwrap();
        let mut child = command(exe, data, scenario, text)
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
        let launched = json!({
            "kind": "mixdog-daemon-crash-capture", "launcher": "core", "launcherPid": 999_999_998, "pid": pid, "detached": true,
            "heapFlags": [], "stderrFile": format!("{stem}.err.log"), "spawnedAt": "2026-11-11T04:15:00.000Z",
            "readyAt": "2026-11-11T04:15:01.000Z", "exitedAt": null, "ready": true, "exitCode": null, "exitSignal": null,
            "uptimeMs": null, "stderrBytes": 0, "error": null,
        });
        std::fs::write(&sidecar, launched.to_string()).unwrap();
        let mut boot = Self { child: Some(child), pid, sidecar, err_log, said, ended: false };
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

/// One end: a start ends as `scenario` (killed from outside for `killed`), the next core starts when `settled_by_next` says a
/// later boot must settle it, and the sidecar is read at the end. Answers the exit code, the sidecar and the fd 2 text.
fn run(scenario: &str, text: &str, settled_by_next: bool, dead_pipe: bool) -> (Option<i32>, Value, String) {
    let (_folder, exe) = binary();
    let data = tempfile::tempdir().unwrap();
    let boot = Boot::start(&exe, data.path(), STEM, scenario, text, dead_pipe);
    if scenario == "killed" {
        boot.heard("installed");
        terminate(boot.pid);
    }
    let (code, mut sidecar, captured) = boot.ended();
    if settled_by_next {
        next_boot(&exe, data.path());
        sidecar = record(&capture_dir(data.path()).join(format!("{STEM}.json")));
    }
    (code, sidecar, captured)
}

#[test]
fn a_core_that_panics_leaves_an_uncaught_exception_record() {
    let (code, sidecar, captured) = run("main-panic", PANIC_MESSAGE, false, false);
    assert_eq!(code, Some(PANIC_EXIT_CODE));
    assert_eq!((&sidecar["exitCode"], &sidecar["exitReason"]), (&json!(1), &json!("fatal uncaughtException")));
    assert_eq!(sidecar["daemonExit"]["reason"], "shutdown: fatal uncaught exception (fatal uncaught exception) (exited with code 1)");
    assert!(sidecar["daemonExit"]["error"].as_str().unwrap().contains(PANIC_MESSAGE), "{sidecar}");
    assert!(captured.contains(PANIC_MESSAGE), "fd 2 holds the panic line: {captured}");
}

/// A start returning an error is a fatal boot error that exits 2.
#[test]
fn a_start_error_leaves_a_fatal_boot_error_record() {
    let (code, sidecar, captured) = run("fatal-error", BOOT_ERROR, false, false);
    assert_eq!(code, Some(2));
    assert_eq!(sidecar["exitCode"], 2);
    assert_eq!(sidecar["daemonExit"]["reason"], "shutdown: fatal boot error (exited with code 2)");
    assert!(captured.contains(&format!("mixdogd: {BOOT_ERROR}")), "{captured}");
}

/// The start-up failing on its own, before the JS runtime is resolved: no `js-runtime.json` stands beside the binary, so
/// resolving it is the first thing that fails; the recorder is installed before that step.
#[test]
fn a_start_that_fails_before_the_runtime_is_resolved_still_leaves_the_fatal_boot_error_record() {
    let (code, sidecar, captured) = run("real", "", false, false);
    assert_eq!(code, Some(2));
    assert_eq!(sidecar["daemonExit"]["reason"], "shutdown: fatal boot error (exited with code 2)");
    assert!(captured.contains("mixdogd: resolving the JS runtime"), "{captured}");
}

/// An exit with no stated reason records its code alone.
#[test]
fn an_exit_with_no_reason_records_its_code_alone() {
    let (code, sidecar, _) = run("exit-code", "", false, false);
    assert_eq!(code, Some(3));
    assert_eq!((&sidecar["exitCode"], &sidecar["daemonExit"]["reason"]), (&json!(3), &json!("exited with code 3")));
}

/// A core killed from outside runs nothing; the next core settles its boot as ended without an exit hook.
#[test]
fn a_killed_core_is_settled_by_the_next_core() {
    let (_, sidecar, _) = run("killed", "", true, false);
    assert!(sidecar["exitReason"].as_str().unwrap().starts_with(UNRECORDED), "{sidecar}");
    assert!(sidecar["exitReconciledAt"].is_string());
}

/// An abort that runs no hook (a stack overflow, an allocation failure) ends the process abnormally and leaves nothing of its
/// own; the next core settles the boot the same way.
#[test]
fn an_abort_that_runs_no_hook_is_settled_by_the_next_core() {
    for scenario in ["stack-overflow", "oom"] {
        let (code, sidecar, _) = run(scenario, "", true, false);
        assert_ne!(code, Some(0), "{scenario} ends the process abnormally");
        assert!(sidecar["exitReason"].as_str().unwrap().starts_with(UNRECORDED), "{scenario}: {sidecar}");
    }
}

/// The launcher gone with its fallback stderr pipe (the read end closed before the core writes): a write to fd 2 fails and is
/// dropped, so the core still ends with its record; nothing blocks or replaces it.
#[test]
fn a_dead_launchers_stderr_pipe_neither_blocks_nor_replaces_the_record() {
    let (code, sidecar, captured) = run("fatal-error", BOOT_ERROR, false, true);
    assert_eq!(code, Some(2));
    assert_eq!(sidecar["daemonExit"]["reason"], "shutdown: fatal boot error (exited with code 2)");
    assert!(captured.is_empty(), "nothing reached the capture file: {captured}");
}

/// A panic on a worker thread that the runtime catches is in the boot's record when it happens; the normal stop that follows
/// names it with the code the stop exits with.
#[test]
fn a_caught_worker_panic_is_in_the_record_when_it_happens_and_the_stop_after_it_names_it() {
    let (_folder, exe) = binary();
    let data = tempfile::tempdir().unwrap();
    let mut boot = Boot::start(&exe, data.path(), "daemon-20261111-041600-999999998-0bad", "caught-panic", PANIC_MESSAGE, false);
    boot.heard("caught");
    let at_panic = record(&boot.sidecar);
    assert_eq!(at_panic["daemonExit"]["reason"], "fatal uncaughtException");
    assert!(at_panic["daemonExit"]["error"].as_str().unwrap().contains(PANIC_MESSAGE), "{at_panic}");
    boot.say("stop");
    let (code, written, _) = boot.ended();
    assert_eq!(code, Some(0));
    assert_eq!(written["exitCode"], 0);
    assert_eq!(written["daemonExit"]["code"], 0);
    assert_eq!(written["daemonExit"]["reason"], "shutdown: no live session clients (fatal uncaught exception) (exited normally (code 0))");
    assert!(written["daemonExit"]["error"].as_str().unwrap().contains(PANIC_MESSAGE), "{written}");
}
