//! Per-thread OS priority (RL §3): set by the thread itself when it starts.
//!
//! - Windows: `SetThreadPriority` `ABOVE_NORMAL` / `NORMAL` / `BELOW_NORMAL`.
//! - Linux: per-thread `setpriority` with nice 0 for above-normal and normal, +10 for
//!   below-normal. The baseline is nice 0, and raising a priority needs no privilege because
//!   "above" is expressed by lowering the others.
//! - macOS: QoS `user-interactive` / `default` / `utility`.

use std::io;

/// The three scheduling levels the executor table uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Priority {
    AboveNormal,
    Normal,
    BelowNormal,
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
compile_error!("mixdog-rt supports Windows, Linux and macOS only");

/// Applies `priority` to the calling thread.
pub(crate) fn set_current_thread(priority: Priority) -> io::Result<()> {
    imp::set_current_thread(priority)
}

#[cfg(windows)]
mod imp {
    use super::Priority;
    use std::io;
    use windows_sys::Win32::System::Threading::GetCurrentThread;
    use windows_sys::Win32::System::Threading::SetThreadPriority;
    use windows_sys::Win32::System::Threading::THREAD_PRIORITY_ABOVE_NORMAL;
    use windows_sys::Win32::System::Threading::THREAD_PRIORITY_BELOW_NORMAL;
    use windows_sys::Win32::System::Threading::THREAD_PRIORITY_NORMAL;

    pub(super) fn set_current_thread(priority: Priority) -> io::Result<()> {
        let level = match priority {
            Priority::AboveNormal => THREAD_PRIORITY_ABOVE_NORMAL,
            Priority::Normal => THREAD_PRIORITY_NORMAL,
            Priority::BelowNormal => THREAD_PRIORITY_BELOW_NORMAL,
        };
        // SAFETY: `GetCurrentThread` returns the calling thread's pseudo handle, valid for
        // this call; `SetThreadPriority` has no other preconditions.
        let ok = unsafe { SetThreadPriority(GetCurrentThread(), level) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::Priority;
    use std::io;

    pub(super) fn set_current_thread(priority: Priority) -> io::Result<()> {
        let nice = match priority {
            Priority::AboveNormal | Priority::Normal => 0,
            Priority::BelowNormal => 10,
        };
        // SAFETY: `gettid` takes no arguments and cannot fail.
        let tid = unsafe { libc::syscall(libc::SYS_gettid) };
        // SAFETY: plain syscall wrapper; `tid` names the calling thread, so the nice value
        // applies to this thread only (Linux keeps nice per task).
        let rc = unsafe { libc::setpriority(libc::PRIO_PROCESS, tid as libc::id_t, nice) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::Priority;
    use std::io;

    pub(super) fn set_current_thread(priority: Priority) -> io::Result<()> {
        let class = match priority {
            Priority::AboveNormal => libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE,
            Priority::Normal => libc::qos_class_t::QOS_CLASS_DEFAULT,
            Priority::BelowNormal => libc::qos_class_t::QOS_CLASS_UTILITY,
        };
        // SAFETY: applies a QoS class to the calling thread; no pointers are involved.
        let rc = unsafe { libc::pthread_set_qos_class_self_np(class, 0) };
        if rc != 0 {
            return Err(io::Error::from_raw_os_error(rc));
        }
        Ok(())
    }
}
