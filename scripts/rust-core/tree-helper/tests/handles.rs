//! Windows: the program holds no handle to the helper's job and none to a process (the helper's watch on its parent is one).
//! `CreateProcessW` is called with bInheritHandles=TRUE by Rust's `Command`, so what keeps a handle from the program is that
//! the helper never makes it inheritable: `win32job` creates the job with null security attributes and the parent watch calls
//! `OpenProcess(.., bInheritHandle = false, ..)`. The Node caller hands the helper only the three stdio handles (libuv
//! duplicates exactly those as inheritable). This test looks from the inside: it re-runs itself as the program under the
//! helper, scans every handle value in the program, and counts job and process handles.
#![cfg(windows)]

use std::ffi::c_void;
use std::process::Command;
use windows::Win32::Foundation::{CloseHandle, GetHandleInformation, HANDLE};
use windows::Win32::System::JobObjects::{
    CreateJobObjectW, JobObjectBasicAccountingInformation, QueryInformationJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
};
use windows::Win32::System::Threading::{GetCurrentProcessId, GetProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

/// How many open handles of this process are jobs, and how many are processes.
fn count_handles() -> (usize, usize) {
    let (mut jobs, mut processes) = (0, 0);
    for value in (4..0x8000usize).step_by(4) {
        let handle = HANDLE(value as *mut c_void);
        let mut flags = 0u32;
        // SAFETY: probing a handle value is defined for any value; every out-pointer is a valid local.
        unsafe {
            if GetHandleInformation(handle, &mut flags).is_err() {
                continue;
            }
            let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            let size = std::mem::size_of_val(&info) as u32;
            if QueryInformationJobObject(Some(handle), JobObjectBasicAccountingInformation, (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(), size, None).is_ok() {
                jobs += 1;
            }
            if GetProcessId(handle) != 0 {
                processes += 1;
            }
        }
    }
    (jobs, processes)
}

/// Entry point of the program the helper runs: prints what it holds. Does nothing in an ordinary test run.
#[test]
fn inspect_as_program() {
    if std::env::var_os("TREERUN_INSPECT").is_some() {
        let (jobs, processes) = count_handles();
        println!("HANDLES jobs={jobs} processes={processes}");
    }
}

#[test]
fn the_program_holds_no_job_and_no_process_handle() {
    // The check is not vacuous: a process that holds one of each counts them.
    // SAFETY: the two handles are created here and closed below.
    let (job, process) = unsafe { (CreateJobObjectW(None, windows::core::PCWSTR::null()).unwrap(), OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, true, GetCurrentProcessId()).unwrap()) };
    let (jobs, processes) = count_handles();
    assert!(jobs >= 1 && processes >= 1, "control: jobs={jobs} processes={processes}");
    // SAFETY: closing the handles opened above.
    unsafe {
        let _ = CloseHandle(job);
        let _ = CloseHandle(process);
    }

    let result = std::env::temp_dir().join(format!("treerun-handles-{}.json", std::process::id()));
    let output = Command::new(env!("CARGO_BIN_EXE_treerun"))
        .arg(&result)
        .arg(std::process::id().to_string())
        .args(["args"])
        .arg(std::env::current_exe().unwrap())
        .args(["--exact", "inspect_as_program", "--nocapture"])
        .env("TREERUN_INSPECT", "1")
        .output()
        .unwrap();
    let _ = std::fs::remove_file(&result);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}{}", String::from_utf8_lossy(&output.stderr));
    assert!(stdout.contains("HANDLES jobs=0 processes=0"), "{stdout}");
}
