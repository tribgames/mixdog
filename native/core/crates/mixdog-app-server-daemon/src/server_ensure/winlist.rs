//! The Windows process table for garbage collection and cleanup: Toolhelp32 names the pids,
//! and the executable path of each comes from the same handle that proves its identity
//! (`OsProcessTable::query`, which also carries the start time), so a reused pid is never
//! mistaken for the process that ran from an install.

use std::io;

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::System::Diagnostics::ToolHelp::CreateToolhelp32Snapshot;
use windows_sys::Win32::System::Diagnostics::ToolHelp::PROCESSENTRY32W;
use windows_sys::Win32::System::Diagnostics::ToolHelp::Process32FirstW;
use windows_sys::Win32::System::Diagnostics::ToolHelp::Process32NextW;
use windows_sys::Win32::System::Diagnostics::ToolHelp::TH32CS_SNAPPROCESS;

use super::host::ProcessImage;
use crate::verdict::OsProcessTable;
use crate::verdict::ProcessTable;

fn pids() -> io::Result<Vec<u32>> {
    // SAFETY: plain FFI call.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: an all-zero PROCESSENTRY32W is a valid value; `dwSize` is set before use.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut pids = Vec::new();
    // SAFETY: `snapshot` is a valid snapshot handle and `entry` a correctly sized buffer.
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while more {
        pids.push(entry.th32ProcessID);
        // SAFETY: as above.
        more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    // SAFETY: the handle was opened above and is closed once.
    unsafe { CloseHandle(snapshot) };
    Ok(pids)
}

/// Every process whose executable path can be read. A process of another user whose image is
/// denied is left out, as on Linux when `/proc/<pid>/exe` is unreadable.
pub fn process_images() -> io::Result<Vec<ProcessImage>> {
    let mut images = Vec::new();
    for pid in pids()? {
        if let Some(image) = OsProcessTable.query(u64::from(pid))?.and_then(|info| info.image) {
            images.push(ProcessImage { pid, image });
        }
    }
    Ok(images)
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the test runs a real process from an install directory")]
mod tests {
    use super::*;

    #[test]
    fn lists_this_process_with_its_own_image() {
        let own = std::env::current_exe().unwrap();
        let images = process_images().unwrap();
        let ours = images.iter().find(|p| p.pid == std::process::id()).expect("own pid is listed");
        assert!(ours.within(own.parent().unwrap()));
    }

    #[test]
    fn collection_removes_an_unused_version_and_keeps_the_one_a_process_runs_from() {
        use std::collections::HashSet;

        use crate::server_ensure::RemotePaths;
        use crate::server_ensure::install::collect;

        let home = tempfile::tempdir().unwrap();
        let paths = RemotePaths::new(home.path());
        let unused = paths.versions.join("1.0.0-old");
        let used = paths.versions.join("1.0.1-live");
        std::fs::create_dir_all(&unused).unwrap();
        std::fs::create_dir_all(&used).unwrap();
        // A real process running from inside the version directory.
        let shell = used.join("sleeper.exe");
        std::fs::copy(r"C:\Windows\System32\ping.exe", &shell).unwrap();
        let mut child = std::process::Command::new(&shell).args(["-n", "30", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        let images = process_images().unwrap();
        let report = collect(&paths, &HashSet::new(), Some(&images));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!unused.exists(), "{report:?}");
        assert!(used.exists(), "an install a process runs from is kept");
    }
}
