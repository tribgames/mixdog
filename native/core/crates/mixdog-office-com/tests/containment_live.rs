//! The containment of an Office host against the real operating system and a real Microsoft Office. Every test is
//! `#[ignore]`d and runs only on request on a Windows machine
//! (`cargo test -p mixdog-office-com --test containment_live -- --ignored`); the Office case also needs
//! `MIXDOG_TEST_LIVE_OFFICE=1`, since it starts Word.
//!
//! * `a_host_outlives_a_killed_worker_and_runs_its_eof_cleanup`: a stand-in for the ext-host worker runs in a kill-on-close
//!   job that allows breakaway, and starts a stand-in host with `CREATE_BREAKAWAY_FROM_JOB`; ending the job ends the worker
//!   and the host still sees its stdin's EOF and runs its cleanup. The stand-ins are this test binary started again with
//!   `MIXDOG_CONTAINMENT_ROLE` set (the `stand_in` test is their entry and does nothing otherwise).
//! * `the_sweep_ends_a_hidden_word_left_by_a_dead_host_and_spares_a_visible_one`: a hidden Word whose host is gone is ended
//!   by the sweep of the next start, and a Word the user has on screen is left running.
#![cfg(windows)]
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the test starts its stand-in processes, lays out a scratch folder and waits on what they leave on disk"
)]

use std::ffi::c_void;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use mixdog_fsio::Unlaned;
use mixdog_office_com::Ownership;
use mixdog_office_com::com::Value;
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::com::live::create_object;
use mixdog_office_com::host::ledger::BACKGROUND;
use mixdog_office_com::host::ledger::Entry;
use mixdog_office_com::host::ledger::Ledger;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::platform::WindowsPlatform;
use mixdog_office_com::sweep::sweep;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_BREAKAWAY_OK;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
use windows_sys::Win32::System::JobObjects::SetInformationJobObject;
use windows_sys::Win32::System::JobObjects::TerminateJobObject;

const ROLE: &str = "MIXDOG_CONTAINMENT_ROLE";
const MARK: &str = "MIXDOG_CONTAINMENT_MARK";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

/// How long the cases wait for something that must happen.
const STEP: Duration = Duration::from_secs(20);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-office-com-containment-live-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

/// The entry point of the stand-ins. Started by the test below with the role in the environment; run alone it does nothing.
#[test]
#[ignore = "the entry of the stand-in processes of a_host_outlives_a_killed_worker_and_runs_its_eof_cleanup"]
fn stand_in() {
    match std::env::var(ROLE).as_deref() {
        Ok("worker") => worker(),
        Ok("host") => host(),
        _ => {}
    }
}

/// The worker: waits to be told it is in its job, starts the host out of the job, says its pid and lives until it is killed.
fn worker() {
    let mut go = String::new();
    std::io::stdin().read_line(&mut go).expect("go");
    let mut command = Command::new(std::env::current_exe().expect("exe"));
    command
        .args(["--ignored", "--exact", "stand_in", "--nocapture"])
        .env(ROLE, "host")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB);
    let child = command.spawn().expect("the job allows breakaway: the host starts outside it");
    println!("host-pid {}", child.id());
    let _ = std::io::stdout().flush();
    // The host's stdin is the pipe this process holds: it ends with this process.
    let _keep = child;
    loop {
        std::thread::park_timeout(Duration::from_secs(1));
    }
}

/// The host: reads stdin to its end, then leaves the mark the test looks for.
fn host() {
    let mut rest = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut rest);
    let mark = std::env::var(MARK).expect("the mark");
    std::fs::write(mark, b"eof").expect("write the mark");
}

fn process_alive(pid: u32) -> bool {
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .expect("tasklist");
    String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
}

fn eventually(what: &str, mut ready: impl FnMut() -> bool) {
    let start = Instant::now();
    while start.elapsed() < STEP {
        if ready() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("never happened: {what}");
}

#[test]
#[ignore = "starts processes and a job object; run on request on Windows"]
fn a_host_outlives_a_killed_worker_and_runs_its_eof_cleanup() {
    let dir = scratch("worker");
    let mark = dir.join("eof.mark");
    // SAFETY: plain Win32 calls on the job created here.
    let job: HANDLE = unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        assert!(!job.is_null(), "{}", std::io::Error::last_os_error());
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        let set = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&info).cast::<c_void>(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        assert!(set != 0, "{}", std::io::Error::last_os_error());
        job
    };
    let mut worker = Command::new(std::env::current_exe().expect("exe"))
        .args(["--ignored", "--exact", "stand_in", "--nocapture"])
        .env(ROLE, "worker")
        .env(MARK, &mark)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .expect("the worker stand-in");
    // SAFETY: both handles are open.
    let assigned = unsafe { AssignProcessToJobObject(job, worker.as_raw_handle() as HANDLE) };
    assert!(assigned != 0, "{}", std::io::Error::last_os_error());
    worker.stdin.as_mut().expect("stdin").write_all(b"go\n").expect("go");

    let mut lines = BufReader::new(worker.stdout.take().expect("stdout")).lines();
    let host_pid = loop {
        let line = lines.next().expect("the worker said no host pid").expect("a line");
        if let Some(pid) = line.trim().strip_prefix("host-pid ") {
            break pid.parse::<u32>().expect("a pid");
        }
    };
    assert!(process_alive(host_pid));

    // The worker crashes: its job ends it and everything that did not break away.
    // SAFETY: the job handle is open.
    unsafe {
        TerminateJobObject(job, 1);
    }
    worker.wait().expect("the worker ended");
    eventually("the host saw its stdin end and left its mark", || mark.exists());
    eventually("the host exited", || !process_alive(host_pid));
    // SAFETY: closed once.
    unsafe {
        CloseHandle(job);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

fn new_process(platform: &WindowsPlatform, before: &[i32]) -> i32 {
    let start = Instant::now();
    while start.elapsed() < STEP {
        if let Some(pid) = platform.office_process_ids("docx").into_iter().find(|pid| !before.contains(pid)) {
            return pid;
        }
        platform.sleep(100);
    }
    panic!("Word did not start a process");
}

/// The record a dead host left for the application `pid`.
fn leave_record(data: &Path, host_pid: u32, platform: &WindowsPlatform, pid: i32, mode: &str) {
    let entry = Entry {
        format: "docx".into(),
        mode: mode.into(),
        ownership: Some(Ownership::Owned),
        owns_application: true,
        app_pid: pid,
        app_start_ticks: platform.process_start_ticks(pid),
        chart_excel: Vec::new(),
    };
    Ledger::new(data, host_pid, 0).record(&Unlaned, &entry).expect("record");
}

/// A pid that belonged to a process which has ended.
fn dead_host_pid() -> u32 {
    let mut child = Command::new("cmd").args(["/C", "exit"]).creation_flags(CREATE_NO_WINDOW).spawn().expect("cmd");
    let pid = child.id();
    child.wait().expect("cmd ended");
    pid
}

#[test]
#[ignore = "starts Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn the_sweep_ends_a_hidden_word_left_by_a_dead_host_and_spares_a_visible_one() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: skipped");
        return;
    }
    let _sta = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let data = scratch("sweep");

    // A hidden Word with a document open, as a background session of a host that was then killed leaves it.
    let before = platform.office_process_ids("docx");
    let hidden = create_object("Word.Application").expect("Word");
    hidden.put("Visible", Value::Bool(false)).expect("hidden");
    hidden.get("Documents").expect("Documents").into_obj().expect("object").call("Add", &[]).expect("a document");
    let pid = new_process(&platform, &before);
    leave_record(&data, dead_host_pid(), &platform, pid, BACKGROUND);
    let report = sweep(&Unlaned, &platform, &data);
    assert_eq!(report.ended, [pid]);
    assert!(!platform.process_exists(pid), "the hidden Word is gone");
    drop(hidden);

    // A Word the user has on screen, wrongly recorded as a background one: it has a visible window, so it stays.
    let before = platform.office_process_ids("docx");
    let shown = create_object("Word.Application").expect("Word");
    shown.put("Visible", Value::Bool(true)).expect("visible");
    let pid = new_process(&platform, &before);
    leave_record(&data, dead_host_pid(), &platform, pid, BACKGROUND);
    let report = sweep(&Unlaned, &platform, &data);
    assert!(report.ended.is_empty());
    assert!(platform.process_exists(pid), "a visible Word is never ended");
    shown.call("Quit", &[Value::I4(0)]).expect("quit the visible Word");
    drop(shown);
    let _ = std::fs::remove_dir_all(&data);
}
