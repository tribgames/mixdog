//! Windows: `LockFileEx` over the bytes of `daemon-owner.lock` that Node's SQLite lock takes, opened
//! without `FILE_SHARE_DELETE`. That handle keeps the lock file, the data dir
//! and every ancestor from being deleted or renamed while the core runs, and
//! the barrier is held open the same way, so revalidation has nothing to check.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the OS lock and barrier pin are held std::fs handles; opened once at startup"
)]

use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;

use mixdog_core_api::domain::ownership::FenceReason;
use windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE;
use windows_sys::Win32::Storage::FileSystem::LOCKFILE_EXCLUSIVE_LOCK;
use windows_sys::Win32::Storage::FileSystem::LOCKFILE_FAIL_IMMEDIATELY;
use windows_sys::Win32::Storage::FileSystem::LockFileEx;
use windows_sys::Win32::System::IO::OVERLAPPED;

use super::AcquireError;
use super::DataDir;
use super::LOCK_FILE;

/// The bytes Node's lock takes: an exclusive SQLite transaction locks the pending, reserved and shared bytes from 1 GiB on
/// (PENDING_BYTE, 2 + 510 bytes). Nothing the file holds lies there, so any other handle can read the file while the lock
/// is held (a locked range refuses reads), and a Node daemon on the same data dir conflicts with this one.
const SQLITE_LOCK_OFFSET: u32 = 0x4000_0000;
const SQLITE_LOCK_LEN: u32 = 512;

pub(super) struct LockFile {
    _file: File,
}

/// The barrier held open without `FILE_SHARE_DELETE` for the core's lifetime.
pub(super) struct BarrierPin {
    _file: File,
}

pub(super) fn lock(dir: &DataDir) -> Result<LockFile, AcquireError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(dir.path().join(LOCK_FILE))
        .map_err(AcquireError::Unavailable)?;
    // SAFETY: a zeroed OVERLAPPED is a valid descriptor; the offset is set below.
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    overlapped.Anonymous.Anonymous.Offset = SQLITE_LOCK_OFFSET;
    // SAFETY: valid file handle and OVERLAPPED; the range lies past any byte of the file.
    let ok = unsafe {
        LockFileEx(
            file.as_raw_handle() as HANDLE,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            SQLITE_LOCK_LEN,
            0,
            &mut overlapped,
        )
    };
    if ok == 0 {
        let error = io::Error::last_os_error();
        return Err(
            if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
                AcquireError::AlreadyOwned
            } else {
                AcquireError::Unavailable(error)
            },
        );
    }
    Ok(LockFile { _file: file })
}

pub(super) fn pin(dir: &DataDir, name: &str) -> io::Result<BarrierPin> {
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(dir.path().join(name))?;
    Ok(BarrierPin { _file: file })
}

pub(super) fn check(
    _dir: &DataDir,
    _lock: &LockFile,
    _barrier: Option<&BarrierPin>,
) -> Result<(), FenceReason> {
    Ok(())
}
