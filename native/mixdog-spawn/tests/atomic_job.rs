//! A Windows child is created inside its job and inherits only its own handles.
#![cfg(windows)]

mod common;

use std::io::BufRead;
use std::io::Read;
use std::os::windows::io::FromRawHandle;
use std::os::windows::process::CommandExt;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

use common::*;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::ProcessManager;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Diagnostics::ToolHelp::CreateToolhelp32Snapshot;
use windows_sys::Win32::System::Diagnostics::ToolHelp::PROCESSENTRY32W;
use windows_sys::Win32::System::Diagnostics::ToolHelp::Process32FirstW;
use windows_sys::Win32::System::Diagnostics::ToolHelp::Process32NextW;
use windows_sys::Win32::System::Diagnostics::ToolHelp::TH32CS_SNAPPROCESS;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::OpenProcess;
use windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE;
use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;
use windows_sys::Win32::System::Threading::TerminateProcess;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

/// The tests start processes from this one, and std's `Command` lets a child inherit every
/// inheritable handle: the pipe of the second test would be held by the first test's helper.
static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The one deadline of every wait on another process.
const WITHIN: Duration = Duration::from_secs(20);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PROGRAM_VAR: &str = "MIXDOG_ATOMIC_JOB_PROGRAM";
const PARKED: &str = "MIXDOG_ATOMIC_JOB_CHILD_CREATED";

/// Pids of the running processes whose image is named `image`.
fn pids_of(image: &str) -> Vec<u32> {
    let mut found = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        assert_ne!(snapshot, INVALID_HANDLE_VALUE);
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry);
        while more != 0 {
            let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case(image) {
                found.push(entry.th32ProcessID);
            }
            more = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
    }
    found
}

fn ping() -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    format!("{root}\\System32\\PING.EXE")
}

fn long_running(program: String) -> CommandSpec {
    CommandSpec::Argv {
        program,
        args: vec!["-n".into(), "120".into(), "127.0.0.1".into()],
    }
}

/// Not a test of its own: the helper process of
/// `a_child_does_not_outlive_a_helper_killed_right_after_creating_it`, which runs this test binary
/// again with `PROGRAM_VAR` set. It starts a child, reports that the OS created it, and waits to be
/// killed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn helper_role_creates_a_child_and_waits_to_be_killed() {
    let Ok(program) = std::env::var(PROGRAM_VAR) else {
        return;
    };
    let m = std::sync::Arc::new(manager());
    let h = handle("atomic-helper");
    mixdog_spawn::testing::arm_created_window();
    let request = request(&h, long_running(program));
    // On its own task: the launch parks its thread in the window.
    let _spawn = tokio::spawn(async move { m.spawn(request).await });
    tokio::task::spawn_blocking(mixdog_spawn::testing::wait_created_window_entered)
        .await
        .unwrap();
    println!("{PARKED}");
    std::thread::park();
}

#[test]
fn a_child_does_not_outlive_a_helper_killed_right_after_creating_it() {
    let _alone = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    // A uniquely named copy of a real executable, so the only process with this image name is the
    // one the helper created.
    let image = format!("mixdog-atomic-{}.exe", std::process::id());
    let program = scratch_dir("atomic").join(&image);
    std::fs::copy(ping(), &program).unwrap();

    let mut helper = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "helper_role_creates_a_child_and_waits_to_be_killed", "--nocapture", "--test-threads=1"])
        .env(PROGRAM_VAR, &program)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .unwrap();
    let stdout = helper.stdout.take().unwrap();
    let (reported, parked) = mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            // With one test thread the harness has already written the test's name on this line.
            if line.ends_with(PARKED) {
                let _ = reported.send(());
                return;
            }
        }
    });
    let reached = parked.recv_timeout(Duration::from_secs(60));
    let pids = pids_of(&image);
    let child = pids.first().map(|pid| unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, *pid) });
    // The helper dies exactly where the child exists and the helper has not done anything more.
    helper.kill().unwrap();
    let (exited, helper_gone) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = exited.send(helper.wait().map(|_| ()));
    });
    helper_gone
        .recv_timeout(WITHIN)
        .expect("the killed helper did not exit within 20 s")
        .unwrap();
    reached.expect("the helper did not report its child created within 60 s");
    assert_eq!(pids.len(), 1, "exactly one child of the helper exists: {pids:?}");
    let child: HANDLE = child.unwrap();
    assert!(!child.is_null(), "the child can be opened");
    let waited = unsafe { WaitForSingleObject(child, 20_000) };
    if waited != WAIT_OBJECT_0 {
        unsafe { TerminateProcess(child, 1) };
    }
    unsafe { CloseHandle(child) };
    let _ = std::fs::remove_file(&program);
    assert_eq!(
        waited, WAIT_OBJECT_0,
        "the child of the killed helper was still running 20 s later, outside any job"
    );
}

/// What the first of two children owns in the helper, while the second is started, must not reach
/// the second: a pipe end that is inheritable in the helper at that moment (a sibling's, as the
/// first child's output pipe is while it starts) is held by the second child too, and the first
/// child's reader then stays open until the second ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_child_does_not_hold_the_first_childs_pipe_open() {
    let _alone = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let (mut read, mut write): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
    let inheritable = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    assert_ne!(unsafe { CreatePipe(&mut read, &mut write, &inheritable, 0) }, 0, "the pipe is created");
    let mut first_output = unsafe { std::fs::File::from_raw_handle(read.cast()) };

    let m = manager();
    let second = handle("atomic-second");
    let spawned = tokio::time::timeout(WITHIN, m.spawn(request(&second, long_running(ping()))))
        .await
        .expect("the second child was not started within 20 s")
        .unwrap();
    // The first child exits: its last owner of the write end lets go.
    unsafe { CloseHandle(write) };

    let (ended, eof) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = ended.send(first_output.read(&mut [0u8; 1]).map(|n| n == 0));
    });
    let first_ended = eof.recv_timeout(WITHIN);
    let second_alive = pid_alive(spawned.pid);
    m.kill(&second).unwrap();
    let collected = tokio::time::timeout(WITHIN, collect(&m, &second)).await;
    assert!(second_alive, "the second child is still running");
    collected.expect("the killed second child did not end within 20 s");
    let at_end = first_ended
        .expect("the first child's pipe did not reach its end within 20 s while the second child ran: the second inherited it")
        .unwrap();
    assert!(at_end, "the pipe's end is reported as the end of the stream");
}
