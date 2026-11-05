//! macOS and Linux: `flock(LOCK_EX|LOCK_NB)` on the open file description of
//! `daemon-owner.lock`, and identity revalidation through the directory handle.

use std::ffi::CString;
use std::io;
use std::os::fd::AsRawFd;
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStrExt;

use mixdog_core_api::domain::ownership::FenceReason;

use super::AcquireError;
use super::DataDir;
use super::LOCK_FILE;
use super::dir::cvt;
use super::dir::file_id;
use crate::barrier::CLAIM_LOCK_FILE;

pub(super) struct LockFile {
    fd: OwnedFd,
}

/// Identity of the installed barrier, recorded at installation.
pub(super) struct BarrierPin {
    id: (u64, u64),
}

fn flock_nb(fd: &OwnedFd) -> io::Result<()> {
    // SAFETY: valid fd.
    cvt(unsafe { libc::flock(fd.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }).map(|_| ())
}

pub(super) fn lock(dir: &DataDir) -> Result<LockFile, AcquireError> {
    let fd = dir
        .openat(
            LOCK_FILE,
            libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW,
            0o600,
        )
        .map_err(AcquireError::Unavailable)?;
    match flock_nb(&fd) {
        Ok(()) => Ok(LockFile { fd }),
        Err(error) if error.raw_os_error() == Some(libc::EWOULDBLOCK) => {
            Err(AcquireError::AlreadyOwned)
        }
        Err(error) => Err(AcquireError::Unavailable(error)),
    }
}

pub(super) fn pin(dir: &DataDir, name: &str) -> io::Result<BarrierPin> {
    Ok(BarrierPin {
        id: file_id(&dir.stat_at(name)?),
    })
}

fn fstat_id(fd: libc::c_int) -> Option<(u64, u64)> {
    // SAFETY: zeroed `stat` is a valid out-parameter.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: valid fd and out-pointer.
    cvt(unsafe { libc::fstat(fd, &mut stat) })
        .ok()
        .map(|_| file_id(&stat))
}

fn stat_path_id(dir: &DataDir) -> Option<(u64, u64)> {
    let path = CString::new(dir.path().as_os_str().as_bytes()).ok()?;
    // SAFETY: zeroed `stat` is a valid out-parameter.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: valid path and out-pointer.
    cvt(unsafe { libc::stat(path.as_ptr(), &mut stat) })
        .ok()
        .map(|_| file_id(&stat))
}

/// LR §2.4, in order: the data path still names the locked directory; the lock
/// file entry is the locked file; the barrier is the installed one; and the
/// lock still holds (an NFSv4 lease lost while suspended fails here).
pub(super) fn check(
    dir: &DataDir,
    lock: &LockFile,
    barrier: Option<&BarrierPin>,
) -> Result<(), FenceReason> {
    let held_dir = fstat_id(dir.raw_fd());
    if held_dir.is_none() || stat_path_id(dir) != held_dir {
        return Err(FenceReason::DataDirReplaced);
    }
    let held_lock = fstat_id(lock.fd.as_raw_fd());
    if held_lock.is_none() || dir.stat_at(LOCK_FILE).ok().map(|stat| file_id(&stat)) != held_lock {
        return Err(FenceReason::LockFileReplaced);
    }
    if let Some(pin) = barrier
        && dir.stat_at(CLAIM_LOCK_FILE).ok().map(|stat| file_id(&stat)) != Some(pin.id)
    {
        return Err(FenceReason::BarrierRemoved);
    }
    flock_nb(&lock.fd).map_err(|_| FenceReason::LockLost)
}
