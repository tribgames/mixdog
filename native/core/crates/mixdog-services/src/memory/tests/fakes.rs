//! Stand-ins for processes a test needs alive, named as a postmaster is told by.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]

use std::path::Path;

/// A process that stays alive and answers nothing, whose image is named `image_name` (a postmaster is told by its image's name, `isPostgresPid`). It is ended when
/// this guard goes, whatever the test did.
pub struct Fake(std::process::Child);

impl Fake {
    pub fn new(dir: &Path, image_name: &str) -> Self {
        let (source, name, args): (&str, String, &[&str]) = if cfg!(windows) {
            (r"C:\Windows\System32\PING.EXE", format!("{image_name}.exe"), &["-n", "60", "127.0.0.1"])
        } else {
            ("/bin/sleep", image_name.to_owned(), &["60"])
        };
        let image = dir.join(name);
        std::fs::copy(source, &image).expect("copy an image");
        Self(std::process::Command::new(image).args(args).stdout(std::process::Stdio::null()).spawn().expect("spawn"))
    }

    pub fn id(&self) -> u32 {
        self.0.id()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A process id that was alive a moment ago and is not any more.
pub fn dead_pid(dir: &Path) -> u32 {
    let gone = Fake::new(dir, "postgres");
    gone.id()
}

pub fn pid_file(dir: &Path, pid: u32, port: u16) {
    std::fs::write(dir.join("postmaster.pid"), format!("{pid}\n{}\n1\n{port}\n", dir.display())).unwrap();
}

/// Whether the process `pid` runs below normal priority (Node's `PRIORITY_BELOW_NORMAL`: the Windows class, nice 10 elsewhere).
pub fn below_normal(pid: u32) -> bool {
    query_below_normal(pid)
}

/// What the OS says the priority of `pid` and of this process is, for a failure message.
pub fn priority_report(pid: u32) -> String {
    format!("process {pid}: {}; this test process {}: {}", describe(pid), std::process::id(), describe(std::process::id()))
}

#[cfg(windows)]
fn describe(pid: u32) -> String {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, GetPriorityClass, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: the handle is opened, queried and closed here.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return "cannot be opened".to_owned();
        }
        let (class, mut exit) = (GetPriorityClass(process), 0u32);
        GetExitCodeProcess(process, &mut exit);
        CloseHandle(process);
        format!("priority class {class:#x} (below normal is {:#x}), exit code {exit} (259 = still running)", windows_sys::Win32::System::Threading::BELOW_NORMAL_PRIORITY_CLASS)
    }
}

#[cfg(unix)]
fn describe(pid: u32) -> String {
    // SAFETY: a plain query of a process's nice value.
    format!("nice {}", unsafe { libc::getpriority(libc::PRIO_PROCESS, pid as libc::id_t) })
}

#[cfg(windows)]
fn query_below_normal(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{BELOW_NORMAL_PRIORITY_CLASS, GetPriorityClass, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: the handle is opened, queried and closed here.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        assert!(!process.is_null(), "the process is open to query");
        let class = GetPriorityClass(process);
        CloseHandle(process);
        class == BELOW_NORMAL_PRIORITY_CLASS
    }
}

#[cfg(unix)]
fn query_below_normal(pid: u32) -> bool {
    // SAFETY: a plain query of another process's nice value.
    unsafe { libc::getpriority(libc::PRIO_PROCESS, pid as libc::id_t) == 10 }
}