//! Windows: `OpenProcess` (`ERROR_INVALID_PARAMETER` = no such process),
//! `GetProcessTimes` for the identity, `GetExtendedTcpTable` for socket owners.

use std::io;
use std::os::windows::io::AsRawHandle;
use std::os::windows::io::FromRawHandle;
use std::os::windows::io::OwnedHandle;
use std::path::PathBuf;

use windows_sys::Wdk::System::Threading::NtQueryInformationProcess;
use windows_sys::Wdk::System::Threading::ProcessCommandLineInformation;
use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::NO_ERROR;
use windows_sys::Win32::Foundation::STILL_ACTIVE;
use windows_sys::Win32::Foundation::UNICODE_STRING;
use windows_sys::Win32::NetworkManagement::IpHelper::GetExtendedTcpTable;
use windows_sys::Win32::NetworkManagement::IpHelper::MIB_TCPTABLE_OWNER_PID;
use windows_sys::Win32::NetworkManagement::IpHelper::TCP_TABLE_OWNER_PID_LISTENER;
use windows_sys::Win32::Networking::WinSock::AF_INET;
use windows_sys::Win32::System::Threading::GetExitCodeProcess;
use windows_sys::Win32::System::Threading::GetProcessTimes;
use windows_sys::Win32::System::Threading::OpenProcess;
use windows_sys::Win32::System::Threading::PROCESS_ACCESS_RIGHTS;
use windows_sys::Win32::System::Threading::PROCESS_NAME_WIN32;
use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;

use super::ProcessIdentity;
use super::ProcessInfo;

/// 100 ns intervals between 1601-01-01 and 1970-01-01.
const UNIX_EPOCH_FILETIME: u64 = 116_444_736_000_000_000;

pub(crate) enum Opened {
    Running(OwnedHandle),
    /// The process exists but this user may not open it.
    Denied,
    Gone,
}

/// Opens `pid` with `access` (plus limited query rights); a handle to a process
/// that already exited is reported `Gone`.
pub(crate) fn open(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> io::Result<Opened> {
    // SAFETY: plain FFI call.
    let raw = unsafe { OpenProcess(access | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if raw.is_null() {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(code) if code == ERROR_INVALID_PARAMETER as i32 => Ok(Opened::Gone),
            Some(code) if code == ERROR_ACCESS_DENIED as i32 => Ok(Opened::Denied),
            _ => Err(error),
        };
    }
    // SAFETY: `raw` is a valid process handle owned from here on.
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut code = 0u32;
    // SAFETY: valid handle and out-pointer.
    if unsafe { GetExitCodeProcess(handle.as_raw_handle() as HANDLE, &mut code) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(if code == STILL_ACTIVE as u32 {
        Opened::Running(handle)
    } else {
        Opened::Gone
    })
}

pub(crate) fn start_ms(handle: &OwnedHandle) -> io::Result<u64> {
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: valid handle and out-pointers.
    let ok = unsafe {
        GetProcessTimes(
            handle.as_raw_handle() as HANDLE,
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    Ok(ticks.saturating_sub(UNIX_EPOCH_FILETIME) / 10_000)
}

fn image(handle: &OwnedHandle) -> Option<PathBuf> {
    let mut buffer = vec![0u16; 32_768];
    let mut len = buffer.len() as u32;
    // SAFETY: valid handle; `len` is the buffer capacity in characters.
    let ok = unsafe {
        QueryFullProcessImageNameW(
            handle.as_raw_handle() as HANDLE,
            PROCESS_NAME_WIN32,
            buffer.as_mut_ptr(),
            &mut len,
        )
    };
    (ok != 0).then(|| PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize])))
}

fn command_line(handle: &OwnedHandle) -> Option<String> {
    let mut buffer = vec![0u64; 512];
    loop {
        let size = (buffer.len() * 8) as u32;
        let mut needed = 0u32;
        // SAFETY: valid handle; the buffer is `size` bytes, 8-byte aligned.
        let status = unsafe {
            NtQueryInformationProcess(
                handle.as_raw_handle() as HANDLE,
                ProcessCommandLineInformation,
                buffer.as_mut_ptr().cast(),
                size,
                &mut needed,
            )
        };
        if status >= 0 {
            break;
        }
        if needed <= size {
            return None;
        }
        buffer = vec![0u64; (needed as usize).div_ceil(8)];
    }
    // SAFETY: on success the buffer starts with a UNICODE_STRING whose Buffer
    // points into the same allocation.
    let text = unsafe {
        let string = &*(buffer.as_ptr() as *const UNICODE_STRING);
        std::slice::from_raw_parts(string.Buffer, usize::from(string.Length) / 2)
    };
    Some(String::from_utf16_lossy(text))
}

pub(super) fn query(pid: u32) -> io::Result<Option<ProcessInfo>> {
    Ok(match open(pid, 0)? {
        Opened::Gone => None,
        Opened::Denied => Some(ProcessInfo {
            identity: ProcessIdentity { pid, start_ms: 0 },
            image: None,
            command_line: None,
        }),
        Opened::Running(handle) => Some(ProcessInfo {
            identity: ProcessIdentity {
                pid,
                start_ms: start_ms(&handle)?,
            },
            image: image(&handle),
            command_line: command_line(&handle),
        }),
    })
}

pub(super) fn listens(pid: u32, port: u16) -> io::Result<bool> {
    let mut buffer = vec![0u32; 1024];
    loop {
        let mut size = (buffer.len() * 4) as u32;
        // SAFETY: the buffer is `size` bytes, 4-byte aligned.
        let rc = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr().cast(),
                &mut size,
                0,
                u32::from(AF_INET),
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if rc == ERROR_INSUFFICIENT_BUFFER {
            buffer = vec![0u32; (size as usize).div_ceil(4)];
            continue;
        }
        if rc != NO_ERROR {
            return Err(io::Error::from_raw_os_error(rc as i32));
        }
        // SAFETY: on success the buffer holds a MIB_TCPTABLE_OWNER_PID with
        // `dwNumEntries` rows.
        let rows = unsafe {
            let table = &*(buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
            std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize)
        };
        return Ok(rows.iter().any(|row| {
            row.dwOwningPid == pid
                && u16::from_be(row.dwLocalPort as u16) == port
                && row.dwLocalAddr.to_ne_bytes() == [127, 0, 0, 1]
        }));
    }
}
