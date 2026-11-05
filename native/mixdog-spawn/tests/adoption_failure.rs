//! A pseudo-console child whose job assignment fails must not be left behind suspended. Alone in
//! its test binary because the failure is injected through a process-wide seam.
#![cfg(windows)]

mod common;

use std::time::Duration;
use std::time::Instant;

use common::*;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::PtySize;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::System::Diagnostics::ToolHelp::CreateToolhelp32Snapshot;
use windows_sys::Win32::System::Diagnostics::ToolHelp::PROCESSENTRY32W;
use windows_sys::Win32::System::Diagnostics::ToolHelp::Process32FirstW;
use windows_sys::Win32::System::Diagnostics::ToolHelp::Process32NextW;
use windows_sys::Win32::System::Diagnostics::ToolHelp::TH32CS_SNAPPROCESS;
use windows_sys::Win32::System::Threading::OpenProcess;
use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;
use windows_sys::Win32::System::Threading::TerminateProcess;

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

fn terminate(pid: u32) {
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !process.is_null() {
            TerminateProcess(process, 1);
            CloseHandle(process);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_child_whose_job_assignment_failed_is_ended() {
    // A uniquely named copy of a real executable, so the only process with this image name is the
    // one the manager created.
    let image = format!("mixdog-leak-{}.exe", std::process::id());
    let path = scratch_dir("adoption").join(&image);
    std::fs::copy(r"C:\Windows\System32\cmd.exe", &path).unwrap();
    let m = manager();
    let h = handle("adoption-failure");
    let command = CommandSpec::Argv {
        program: path.display().to_string(),
        args: vec!["/c".into(), "exit".into()],
    };
    mixdog_spawn::testing::fail_next_adoption();
    let result = m.spawn(pty_request(&h, command, PtySize { cols: 80, rows: 24 })).await;
    assert!(result.is_err(), "the injected failure is reported");
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut left = pids_of(&image);
    while !left.is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
        left = pids_of(&image);
    }
    for pid in &left {
        terminate(*pid);
    }
    assert!(left.is_empty(), "a suspended child was left behind: {left:?}");
    assert_eq!(m.live(), 0, "the admission slot is free");
    let _ = std::fs::remove_file(&path);
}
