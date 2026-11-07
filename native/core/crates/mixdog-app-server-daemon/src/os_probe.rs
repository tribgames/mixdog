//! `runtimeAlive(pid)` for the restart settlement (Node `agent-tool/helpers.mjs`):
//! `try { process.kill(id, 0); return true; } catch (error) { return error?.code === 'EPERM'; }`.
//! The production [`ProcessProbe`] the agent registry's
//! [`Liveness`](mixdog_core_session::session::agent_registry::restart::Liveness) asks whether the
//! process that ran a worker's turn still exists. `id <= 0 || id === process.pid` (alive) is
//! `Liveness`'s, in front of the probe.
//!
//! It answers what `kill(pid, 0)` answers on each OS, not what the process table lists (the table
//! drops a zombie, `kill` does not). A pid Node's `process.kill` refuses (not an `int`) throws
//! `ERR_INVALID_ARG_TYPE`, not `EPERM`: not alive.
//! - Unix: `kill(pid, 0)`; success or `EPERM` is alive, `ESRCH` and anything else is not.
//! - Windows: libuv `uv_kill(pid, 0)` (`src/win/process.c`): `OpenProcess(PROCESS_TERMINATE |
//!   PROCESS_QUERY_INFORMATION | SYNCHRONIZE, FALSE, pid)`; a null handle is `ESRCH` for
//!   `ERROR_INVALID_PARAMETER`, else the translated error; then the health check
//!   `GetExitCodeProcess` (an exit code other than `STILL_ACTIVE` is `ESRCH`) and
//!   `WaitForSingleObject(handle, 0)` (`WAIT_OBJECT_0` is `ESRCH`, `WAIT_TIMEOUT` is alive).
//!   libuv's translation (`src/win/error.c`) makes `ERROR_ACCESS_DENIED` and
//!   `ERROR_PRIVILEGE_NOT_HELD` `UV_EPERM`: alive; every other error is not.

use mixdog_core_session::session::agent_registry::restart::ProcessProbe;

pub struct OsProbe;

impl ProcessProbe for OsProbe {
    fn alive(&self, pid: u64) -> bool {
        // Node's `pid != (pid | 0)` check: only a 32-bit signed integer reaches the OS.
        i32::try_from(pid).is_ok_and(sys::alive)
    }
}

#[cfg(unix)]
mod sys {
    pub(super) fn alive(pid: i32) -> bool {
        // SAFETY: plain FFI call; signal 0 only checks that the process can be signalled.
        if unsafe { libc::kill(pid, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

#[cfg(windows)]
mod sys {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::io::FromRawHandle;
    use std::os::windows::io::OwnedHandle;

    use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
    use windows_sys::Win32::Foundation::ERROR_PRIVILEGE_NOT_HELD;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Foundation::STILL_ACTIVE;
    use windows_sys::Win32::Foundation::WAIT_FAILED;
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
    use windows_sys::Win32::System::Threading::GetExitCodeProcess;
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_INFORMATION;
    use windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE;
    use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;
    use windows_sys::Win32::System::Threading::WaitForSingleObject;

    /// `uv_translate_sys_error(GetLastError()) == UV_EPERM`.
    fn denied() -> bool {
        matches!(io::Error::last_os_error().raw_os_error(), Some(code) if code == ERROR_ACCESS_DENIED as i32 || code == ERROR_PRIVILEGE_NOT_HELD as i32)
    }

    pub(super) fn alive(pid: i32) -> bool {
        // `uv_kill(0, ..)` signals the caller itself; `Liveness` never asks for pid 0.
        // SAFETY: plain FFI call.
        let raw = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid as u32) };
        if raw.is_null() {
            return denied();
        }
        // SAFETY: `raw` is a valid process handle owned from here on.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let raw = handle.as_raw_handle() as HANDLE;
        let mut status = 0u32;
        // SAFETY: valid handle and out-pointer.
        if unsafe { GetExitCodeProcess(raw, &mut status) } == 0 {
            return denied();
        }
        if status != STILL_ACTIVE as u32 {
            return false;
        }
        // SAFETY: valid handle; a zero timeout only polls.
        match unsafe { WaitForSingleObject(raw, 0) } {
            WAIT_OBJECT_0 => false,
            WAIT_TIMEOUT => true,
            WAIT_FAILED => denied(),
            // libuv: `default: return UV_UNKNOWN`.
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_is_alive_and_a_pid_node_cannot_signal_is_not() {
        assert!(OsProbe.alive(u64::from(std::process::id())));
        assert!(!OsProbe.alive(4_294_967_296));
        assert!(!OsProbe.alive(u64::from(u32::MAX)));
    }
}
