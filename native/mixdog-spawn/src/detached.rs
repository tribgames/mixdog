//! A process the core starts and then forgets: Node's
//! `spawn(program, args, { stdio: 'ignore', detached, windowsHide: true })` followed by `unref()`
//! (`runtime/shared/open-url.mjs`, `spawn-flags.mjs` `detachedSpawnOpts`). It is not placed in a
//! job, is not tracked by the manager and is not killed with the core: on Windows it leaves the
//! job its starter runs in when that job lets it, as the job the `mixdog` program ends the
//! `mixdogd` it handed its run to with does. Its exit is collected by a thread that does nothing
//! else (libuv does the same for Node), so no zombie waits.

use std::process::Command;
use std::process::Stdio;

/// `CREATE_NO_WINDOW`: `windowsHide`. Windows never gets `DETACHED_PROCESS` (it would make the
/// OS ignore the hidden window).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// `CREATE_BREAKAWAY_FROM_JOB`: outside the starter's job, so the end of that job is not this
/// process's end.
#[cfg(windows)]
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

/// Starts `program` with its streams ignored, on Windows without a window and outside its
/// starter's job, elsewhere as the leader of a session of its own (libuv's `detached`). Answers
/// the pid; the exit is reaped by a thread of its own, whatever the status.
pub fn spawn_detached(program: &str, args: &[String]) -> std::io::Result<u32> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    // SAFETY: the closure only calls the async-signal-safe `setsid`.
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(&mut command, || {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = start(&mut command)?;
    let pid = child.id();
    std::thread::Builder::new().name("detached-reaper".into()).spawn(move || drop(child.wait()))?;
    Ok(pid)
}

/// A job that does not allow breakaway refuses the flag (`ERROR_ACCESS_DENIED`): the process then
/// starts inside it.
#[cfg(windows)]
fn start(command: &mut Command) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    const ERROR_ACCESS_DENIED: i32 = 5;
    match command.creation_flags(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB).spawn() {
        Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED) => command.creation_flags(CREATE_NO_WINDOW).spawn(),
        started => started,
    }
}

#[cfg(not(windows))]
fn start(command: &mut Command) -> std::io::Result<std::process::Child> {
    command.spawn()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_program_that_cannot_start_is_the_callers_error() {
        let error = spawn_detached("mixdog-no-such-program", &[]).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn a_started_program_runs_on_its_own() {
        let (program, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd.exe", vec!["/C".into(), "exit 0".into()]) } else { ("true", Vec::new()) };
        assert!(spawn_detached(program, &args).unwrap() > 0);
    }

    /// Makes [`starts_a_detached_program`] the starter of the test below, and names the file it
    /// writes the started program's pid to.
    #[cfg(windows)]
    const PID_FILE: &str = "MIXDOG_DETACHED_PID_FILE";

    /// The body of the starter the test below runs in its job; a no-op in a normal run.
    #[cfg(windows)]
    #[test]
    fn starts_a_detached_program() {
        let Some(file) = std::env::var_os(PID_FILE) else { return };
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let pid = spawn_detached(&format!("{root}\\System32\\PING.EXE"), &["-n".into(), "60".into(), "127.0.0.1".into()]).unwrap();
        std::fs::write(file, pid.to_string()).unwrap();
    }

    /// What `mixdogd` starts detached (the browser `cmd start` opens) outlives the `mixdog` that
    /// handed it its run: the job that ends `mixdogd` with `mixdog` (mixdog-entry `handoff.rs`:
    /// kill on close, breakaway allowed) does not hold it.
    #[cfg(windows)]
    #[test]
    fn a_detached_program_leaves_the_job_its_starter_runs_in() {
        use std::ffi::OsString;
        use std::os::windows::io::AsRawHandle;

        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
        use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
        use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
        use windows_sys::Win32::System::JobObjects::SetInformationJobObject;
        use windows_sys::Win32::System::Threading::OpenProcess;
        use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
        use windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE;
        use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;
        use windows_sys::Win32::System::Threading::TerminateProcess;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;

        use crate::winspawn;

        /// The detached program, ended with the test.
        struct Started(HANDLE);
        impl Drop for Started {
            fn drop(&mut self) {
                unsafe {
                    TerminateProcess(self.0, 1);
                    CloseHandle(self.0);
                }
            }
        }

        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        assert!(!job.is_null());
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        assert_ne!(unsafe { SetInformationJobObject(job, JobObjectExtendedLimitInformation, std::ptr::from_ref(&limits).cast(), size) }, 0);

        let file = std::env::temp_dir().join(format!("mixdog-detached-{}.pid", std::process::id()));
        let exe = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        let line = format!("\"{exe}\" --exact detached::tests::starts_a_detached_program --nocapture");
        let mut env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
        env.push((OsString::from(PID_FILE), file.clone().into_os_string()));
        let starter = winspawn::spawn(
            job,
            &winspawn::Spawn {
                program: &exe,
                command_line: &line,
                cwd: None,
                env: Some(&env),
                stdio: winspawn::Stdio::Handles { stdin: None, stdout: None, stderr: None },
            },
        )
        .expect("the starter starts in the job");
        assert_eq!(unsafe { WaitForSingleObject(starter.as_raw_handle() as HANDLE, 60_000) }, WAIT_OBJECT_0, "the starter did not end within 60 s");
        assert!(starter.wait().unwrap().success(), "the starter failed");
        let pid: u32 = std::fs::read_to_string(&file).unwrap().parse().unwrap();
        let _ = std::fs::remove_file(&file);

        let detached = Started(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) });
        assert!(!detached.0.is_null(), "the detached program {pid} is not running");
        assert_eq!(unsafe { WaitForSingleObject(detached.0, 0) }, WAIT_TIMEOUT, "the detached program has ended");
        let mut inside = 0;
        let asked = unsafe { IsProcessInJob(detached.0, job, &mut inside) };
        unsafe { CloseHandle(job) };
        assert_ne!(asked, 0, "the job membership could not be read");
        assert_eq!(inside, 0, "the detached program is in its starter's job, and ends with it");
    }
}
