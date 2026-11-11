use std::io;
use std::os::windows::io::AsRawHandle;
use std::os::windows::io::FromRawHandle;
use std::os::windows::io::OwnedHandle;

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Foundation::WAIT_FAILED;
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::Storage::FileSystem::FILE_NOTIFY_CHANGE_DIR_NAME;
use windows_sys::Win32::Storage::FileSystem::FILE_NOTIFY_CHANGE_FILE_NAME;
use windows_sys::Win32::Storage::FileSystem::FILE_NOTIFY_CHANGE_LAST_WRITE;
use windows_sys::Win32::Storage::FileSystem::FILE_NOTIFY_CHANGE_SIZE;
use windows_sys::Win32::Storage::FileSystem::FindCloseChangeNotification;
use windows_sys::Win32::Storage::FileSystem::FindFirstChangeNotificationW;
use windows_sys::Win32::System::Threading::CreateEventW;
use windows_sys::Win32::System::Threading::INFINITE;
use windows_sys::Win32::System::Threading::PROCESS_ACCESS_RIGHTS;
use windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE;
use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;
use windows_sys::Win32::System::Threading::SetEvent;
use windows_sys::Win32::System::Threading::TerminateProcess;
use windows_sys::Win32::System::Threading::WaitForMultipleObjects;

use super::Wake;
use crate::ownership::DataDir;
use crate::verdict::ProcessIdentity;
use crate::verdict::process::windows::Opened;
use crate::verdict::process::windows::open;
use crate::verdict::process::windows::start_ms;

fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

/// An auto-reset event: a wait that reports it consumes it.
pub(super) struct Event(OwnedHandle);

impl Event {
    pub(super) fn new() -> io::Result<Self> {
        // SAFETY: plain FFI call; auto-reset, initially unsignalled, unnamed.
        let handle = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a valid event handle owned from here on.
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle) }))
    }

    pub(super) fn signal(&self) -> io::Result<()> {
        // SAFETY: valid event handle.
        if unsafe { SetEvent(raw(&self.0)) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

pub(super) struct DirWatch(HANDLE);

// SAFETY: a change-notification handle may be waited on and closed from any thread.
unsafe impl Send for DirWatch {}
// SAFETY: as above; waiting is a read-only use of the handle.
unsafe impl Sync for DirWatch {}

impl DirWatch {
    pub(super) fn arm(dir: &DataDir) -> io::Result<Self> {
        let path = crate::ownership::dir_wide(dir.path());
        let filter = FILE_NOTIFY_CHANGE_FILE_NAME
            | FILE_NOTIFY_CHANGE_DIR_NAME
            | FILE_NOTIFY_CHANGE_LAST_WRITE
            | FILE_NOTIFY_CHANGE_SIZE;
        // SAFETY: NUL-terminated wide path.
        let handle = unsafe { FindFirstChangeNotificationW(path.as_ptr(), 0, filter) };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(handle))
    }
}

impl Drop for DirWatch {
    fn drop(&mut self) {
        // SAFETY: the handle came from FindFirstChangeNotificationW and is closed once.
        unsafe { FindCloseChangeNotification(self.0) };
    }
}

pub(super) struct ExitWatch(OwnedHandle);

impl ExitWatch {
    pub(super) fn open(identity: ProcessIdentity) -> io::Result<Option<Self>> {
        Self::open_with(identity, PROCESS_SYNCHRONIZE)
    }

    /// A watch that may also end the process.
    pub(super) fn open_to_end(identity: ProcessIdentity) -> io::Result<Option<Self>> {
        Self::open_with(identity, PROCESS_SYNCHRONIZE | PROCESS_TERMINATE)
    }

    /// Windows has no SIGTERM: Node's `process.kill` (libuv `uv_kill`) ends the process with exit code 1 for either
    /// signal, and so does this.
    pub(super) fn signal(&self, _kill: bool) -> io::Result<()> {
        // SAFETY: a valid process handle opened with PROCESS_TERMINATE.
        if unsafe { TerminateProcess(raw(&self.0), 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn open_with(identity: ProcessIdentity, access: PROCESS_ACCESS_RIGHTS) -> io::Result<Option<Self>> {
        Ok(match open(identity.pid, access)? {
            Opened::Gone => None,
            Opened::Denied => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("cannot wait for process {}", identity.pid),
                ));
            }
            Opened::Running(handle) => {
                (start_ms(&handle)? == identity.start_ms).then_some(Self(handle))
            }
        })
    }
}

pub(super) fn wait(
    event: &Event,
    dir: Option<&DirWatch>,
    exit: Option<&ExitWatch>,
) -> io::Result<Wake> {
    let mut handles: Vec<(HANDLE, Wake)> = Vec::with_capacity(3);
    if let Some(exit) = exit {
        handles.push((raw(&exit.0), Wake::Exited));
    }
    if let Some(dir) = dir {
        handles.push((dir.0, Wake::Changed));
    }
    handles.push((raw(&event.0), Wake::Interrupted));
    let raw_handles: Vec<HANDLE> = handles.iter().map(|(handle, _)| *handle).collect();
    // SAFETY: every handle is valid for the duration of the call.
    let rc = unsafe {
        WaitForMultipleObjects(raw_handles.len() as u32, raw_handles.as_ptr(), 0, INFINITE)
    };
    if rc == WAIT_FAILED {
        return Err(io::Error::last_os_error());
    }
    handles
        .get(rc.wrapping_sub(WAIT_OBJECT_0) as usize)
        .map(|(_, wake)| *wake)
        .ok_or_else(|| io::Error::other(format!("unexpected wait result {rc}")))
}
