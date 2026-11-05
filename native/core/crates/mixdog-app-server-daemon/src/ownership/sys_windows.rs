//! Windows: `LockFileEx` over the whole range of `daemon-owner.lock`, opened
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
    // SAFETY: a zeroed OVERLAPPED is a valid offset-0 descriptor.
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    // SAFETY: valid file handle and OVERLAPPED; the range is the whole file space.
    let ok = unsafe {
        LockFileEx(
            file.as_raw_handle() as HANDLE,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            u32::MAX,
            u32::MAX,
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
