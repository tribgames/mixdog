//! What this program hands to the `mixdogd` installed beside it, which holds the core this one does not: `exec`, and the helper
//! subcommands a core starts its own program with. The run is `mixdogd`'s with this process's standard streams, console, working
//! folder and environment, and its exit status is this program's: on Unix this process becomes `mixdogd`; on Windows it waits for
//! it, leaves Ctrl+C and Ctrl+Break to it, as it shares this console, and ends it when this process is ended. No other `mixdogd`
//! stands in for the one beside this program: a missing one, or one of another version, is refused.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the hand-off is this process's one start of another program, made instead of any work of its own"
)]

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;

/// The file name of `mixdogd`.
const DAEMON: &str = if cfg!(windows) { "mixdogd.exe" } else { "mixdogd" };

/// What `mixdogd --version` prints for the build this program is of.
fn own_version() -> String {
    format!("mixdogd {}", env!("CARGO_PKG_VERSION"))
}

/// The `mixdogd` beside `program`, refused (the line that says why) when there is none or it reports another version than this
/// program's; `version` runs it with `--version`.
pub fn daemon_beside(program: &Path, version: &dyn Fn(&Path) -> std::io::Result<String>) -> Result<PathBuf, String> {
    let daemon = program.with_file_name(DAEMON);
    if !daemon.is_file() {
        return Err(format!("{} is missing: this program runs `exec` and the core's helpers on the mixdogd installed beside it", daemon.display()));
    }
    let reported = version(&daemon).map_err(|error| format!("cannot run {}: {error}", daemon.display()))?;
    let (reported, own) = (reported.trim(), own_version());
    if reported != own {
        return Err(format!("{} reports {reported:?}, not {own}: it is not the mixdogd of this program's version", daemon.display()));
    }
    Ok(daemon)
}

fn reported_version(daemon: &Path) -> std::io::Result<String> {
    let mut command = Command::new(daemon);
    command.arg("--version").stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, console_flags());
    Ok(String::from_utf8_lossy(&command.output()?.stdout).into_owned())
}

/// Runs `mixdogd words` in place of this program and answers its exit status; what keeps it from running is one `mixdog:` line on
/// stderr and status 1.
pub fn hand_off(words: &[OsString]) -> i32 {
    let started = std::env::current_exe()
        .map_err(|error| format!("cannot locate this program: {error}"))
        .and_then(|program| daemon_beside(&program, &reported_version))
        .and_then(|daemon| run(&daemon, words));
    started.unwrap_or_else(|line| {
        eprintln!("mixdog: {line}");
        1
    })
}

#[cfg(unix)]
fn run(daemon: &Path, words: &[OsString]) -> Result<i32, String> {
    use std::os::unix::process::CommandExt;
    let error = Command::new(daemon).args(words).exec();
    Err(format!("cannot run {}: {error}", daemon.display()))
}

#[cfg(windows)]
fn run(daemon: &Path, words: &[OsString]) -> Result<i32, String> {
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    leave_interrupts_to_the_daemon();
    let mut command = Command::new(daemon);
    command.args(words);
    std::os::windows::process::CommandExt::creation_flags(&mut command, CREATE_SUSPENDED | console_flags());
    let mut child = command.spawn().map_err(|error| format!("cannot run {}: {error}", daemon.display()))?;
    job::start_bound(&mut child).map_err(|error| format!("cannot run {}: {error}", daemon.display()))?;
    let status = child.wait().map_err(|error| format!("cannot run {}: {error}", daemon.display()))?;
    Ok(status.code().unwrap_or(1))
}

/// Ending this process ends the `mixdogd` it handed its run to, as it ended the run this program once made in its own process.
#[cfg(windows)]
mod job {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
    use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
    use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
    use windows_sys::Win32::System::JobObjects::SetInformationJobObject;

    #[link(name = "ntdll")]
    unsafe extern "system" {
        /// Resumes every thread of a process created suspended.
        fn NtResumeProcess(process: HANDLE) -> i32;
    }

    /// Puts `child`, created suspended, in a job whose one handle is this process's, so the system ends what the job holds when
    /// this process ends however it ends, and lets it run. A process `mixdogd` starts with `CREATE_BREAKAWAY_FROM_JOB` (the Office
    /// hosts, and what it starts detached: the browser it opens) still leaves the job. A child the system does not let join a job
    /// runs outside one.
    pub(super) fn start_bound(child: &mut std::process::Child) -> Result<(), String> {
        let process = child.as_raw_handle() as HANDLE;
        // SAFETY: plain Win32 calls on a job handle made here, left open for the life of this process, and on the live child's handle.
        let resumed = unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if !job.is_null() {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
                let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
                if SetInformationJobObject(job, JobObjectExtendedLimitInformation, std::ptr::from_ref(&info).cast::<c_void>(), size) != 0 {
                    AssignProcessToJobObject(job, process);
                }
            }
            NtResumeProcess(process)
        };
        if resumed < 0 {
            let _ = child.kill();
            return Err(format!("it could not be resumed (NTSTATUS 0x{resumed:08x})"));
        }
        Ok(())
    }
}

/// Ctrl+C and Ctrl+Break reach every process of the console: `mixdogd` answers them (an exec ends with 130 after its shutdown) and
/// this process waits for that end. A registered routine is not inherited, so `mixdogd` keeps its own handling.
#[cfg(windows)]
fn leave_interrupts_to_the_daemon() {
    use windows_sys::Win32::System::Console::CTRL_BREAK_EVENT;
    use windows_sys::Win32::System::Console::CTRL_C_EVENT;
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
    unsafe extern "system" fn handled(kind: u32) -> i32 {
        i32::from(kind == CTRL_C_EVENT || kind == CTRL_BREAK_EVENT)
    }
    // SAFETY: registers a handler routine with the signature the system expects.
    unsafe { SetConsoleCtrlHandler(Some(handled), 1) };
}

/// A console program started from a process without a console opens a console window of its own: `mixdogd` is started without one
/// then (`CREATE_NO_WINDOW`), and otherwise shares this process's console.
#[cfg(windows)]
fn console_flags() -> u32 {
    use windows_sys::Win32::System::Console::GetConsoleProcessList;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut attached = [0u32; 1];
    // SAFETY: the list is written into `attached`, whose length is the count passed; zero means this process has no console.
    if unsafe { GetConsoleProcessList(attached.as_mut_ptr(), 1) } == 0 { CREATE_NO_WINDOW } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reporting(line: &str) -> impl Fn(&Path) -> std::io::Result<String> + '_ {
        move |_| Ok(line.to_owned())
    }

    #[test]
    fn the_daemon_is_the_mixdogd_beside_the_program_and_of_its_version() {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join(if cfg!(windows) { "mixdog.exe" } else { "mixdog" });
        let daemon = dir.path().join(DAEMON);
        let missing = daemon_beside(&program, &|_| panic!("a missing mixdogd is not run")).unwrap_err();
        assert!(missing.starts_with(&format!("{} is missing", daemon.display())), "{missing}");

        std::fs::write(&daemon, b"").unwrap();
        let own = format!("mixdogd {}\n", env!("CARGO_PKG_VERSION"));
        assert_eq!(daemon_beside(&program, &reporting(&own)), Ok(daemon.clone()));
        let other = daemon_beside(&program, &reporting("mixdogd 0.0.1\n")).unwrap_err();
        assert!(other.contains("reports \"mixdogd 0.0.1\", not mixdogd "), "{other}");
        let silent = daemon_beside(&program, &reporting("")).unwrap_err();
        assert!(silent.contains("reports \"\""), "{silent}");
        let broken = daemon_beside(&program, &|_| Err(std::io::Error::other("not a program"))).unwrap_err();
        assert_eq!(broken, format!("cannot run {}: not a program", daemon.display()));
    }
}
