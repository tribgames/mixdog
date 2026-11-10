//! Windows: the program holds no handle to the helper's job and none to a process (the helper's watch on its parent is one).
//! `CreateProcessW` is called with bInheritHandles=TRUE by Rust's `Command`, so what keeps a handle from the program is that
//! the helper never makes it inheritable: `win32job` creates the job with null security attributes and the parent watch calls
//! `OpenProcess(.., bInheritHandle = false, ..)`. The Node caller hands the helper only the three stdio handles (libuv
//! duplicates exactly those as inheritable). This test looks from the inside: it re-runs itself as the program under the
//! helper, scans every handle value in the program, and counts job and process handles.
#![cfg(windows)]

use std::ffi::c_void;
use std::io::Read;
use std::os::windows::io::AsRawHandle;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use windows::Win32::Foundation::{CloseHandle, GetHandleInformation, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::JobObjects::{
    CreateJobObjectW, JobObjectBasicAccountingInformation, QueryInformationJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
};
use windows::Win32::System::Threading::{GetCurrentProcessId, GetProcessId, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION};

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
    let mut helper = Command::new(env!("CARGO_BIN_EXE_treerun"))
        .arg(&result)
        .arg("handles-run")
        .arg(std::process::id().to_string())
        .args(["args"])
        .arg(std::env::current_exe().unwrap())
        .args(["--exact", "inspect_as_program", "--nocapture"])
        .env("TREERUN_INSPECT", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = read_to_end(helper.stdout.take().unwrap());
    let stderr = read_to_end(helper.stderr.take().unwrap());
    // SAFETY: the handle is the helper's own, owned by `helper` for the whole wait.
    let waited = unsafe { WaitForSingleObject(HANDLE(helper.as_raw_handle()), HELPER_DEADLINE_MS) };
    if waited != WAIT_OBJECT_0 {
        // The helper is this test's own child, ended by its handle; its job ends the program with it.
        let _ = helper.kill();
        let _ = helper.wait();
        panic!("the helper running the inspection did not exit within {HELPER_DEADLINE_MS} ms");
    }
    let status = helper.wait().unwrap();
    let _ = std::fs::remove_file(&result);
    let pipe = |rx: mpsc::Receiver<Vec<u8>>, name: &str| String::from_utf8_lossy(&rx.recv_timeout(Duration::from_secs(30)).unwrap_or_else(|_| panic!("the helper's {name} did not close within 30 s of its exit"))).into_owned();
    let (stdout, stderr) = (pipe(stdout, "stdout"), pipe(stderr, "stderr"));
    assert!(status.success(), "{stdout}{stderr}");
    assert!(stdout.contains("HANDLES jobs=0 processes=0"), "{stdout}");
}

const HELPER_DEADLINE_MS: u32 = 60_000;

/// Reads a pipe to its end on a thread of its own; the receiver gets the bytes.
fn read_to_end(mut pipe: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    rx
}
