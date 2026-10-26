//! The service <-> helper graceful-shutdown channel.
//!
//! Each helper launch gets a pair of named, manual-reset events built from a
//! fresh unguessable token ([`crate::paths::shutdown_event_names`]): the service
//! signals **stop**; the helper, after it has released every pointer button and
//! key it holds, signals **ack** and exits. Both objects carry a protected
//! SYSTEM-only DACL ([`crate::security::SHUTDOWN_EVENT_SDDL`]), so no user
//! process can forge a stop or an acknowledgement, and the service refuses a
//! name that already exists, so nothing can pre-create (squat) the pair.
//!
//! The helper waits on the stop event in every blocking step it takes (pipe
//! accept, its loop sleep, a final linger), so it reacts within one loop
//! iteration. The service still bounds the whole exchange by the helper's
//! documented deadline ([`crate::helper::SHUTDOWN_DEADLINE`]) and only then
//! force-kills.

use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{
    CreateEventW, OpenEventW, SetEvent, WaitForMultipleObjects, WaitForSingleObject, EVENT_MODIFY_STATE,
    SYNCHRONIZATION_SYNCHRONIZE,
};

use crate::paths::shutdown_event_names;
use crate::security::SHUTDOWN_EVENT_SDDL;
use crate::winutil::{wide, OwnedHandle, SecurityDescriptor};

fn millis(duration: Duration) -> u32 {
    duration.as_millis().min(u32::MAX as u128 - 1) as u32
}

/// The service's end: owns both events for one helper launch.
pub struct ServiceEnd {
    stop: OwnedHandle,
    ack: OwnedHandle,
}

/// Create one fresh, SYSTEM-only, manual-reset named event, refusing a name that
/// already exists (an existing object could have been created by someone else).
fn create_event(name: &str, descriptor: &SecurityDescriptor) -> windows::core::Result<OwnedHandle> {
    let attributes = descriptor.attributes();
    let wname = wide(name);
    let handle = unsafe { CreateEventW(Some(&attributes as *const _), true, false, PCWSTR(wname.as_ptr())) }?;
    let already_existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    let owned = OwnedHandle::new(handle).ok_or_else(windows::core::Error::from_thread)?;
    if already_existed {
        return Err(ERROR_ALREADY_EXISTS.to_hresult().into());
    }
    Ok(owned)
}

impl ServiceEnd {
    /// Create the event pair for `token` before the helper is launched.
    pub fn create(token: &str) -> windows::core::Result<Self> {
        let descriptor = SecurityDescriptor::from_sddl(SHUTDOWN_EVENT_SDDL)?;
        let (stop, ack) = shutdown_event_names(token);
        Ok(ServiceEnd {
            stop: create_event(&stop, &descriptor)?,
            ack: create_event(&ack, &descriptor)?,
        })
    }

    /// Ask the helper to release everything it holds and exit.
    pub fn request_stop(&self) {
        unsafe {
            let _ = SetEvent(self.stop.get());
        }
    }

    /// Wait until the helper acknowledges or `process` exits (whichever comes
    /// first), then until `process` exits — all bounded by `deadline`, waking
    /// every `slice` to call `progress` (the SCM checkpoint). Returns whether
    /// the helper acknowledged, and whether the process has exited.
    pub fn wait_for_exit(
        &self,
        process: HANDLE,
        deadline: Instant,
        slice: Duration,
        mut progress: impl FnMut(),
    ) -> (bool, bool) {
        let mut acked = false;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let wait = millis(remaining.min(slice));
            if !acked {
                let handles = [self.ack.get(), process];
                let result = unsafe { WaitForMultipleObjects(&handles, false, wait) };
                if result == WAIT_OBJECT_0 {
                    acked = true;
                    continue;
                }
                if result.0 == WAIT_OBJECT_0.0 + 1 {
                    // Exited without acknowledging (e.g. it crashed before it
                    // could release). The caller logs it; nothing is left to kill.
                    return (false, true);
                }
            } else if unsafe { WaitForSingleObject(process, wait) } == WAIT_OBJECT_0 {
                return (true, true);
            }
            if remaining.is_zero() {
                return (acked, false);
            }
            progress();
        }
    }
}

/// The helper's end: waits on stop, signals ack.
pub struct HelperEnd {
    stop: OwnedHandle,
    ack: OwnedHandle,
}

impl HelperEnd {
    /// Open the pair the service created for `token`.
    pub fn open(token: &str) -> windows::core::Result<Self> {
        let (stop, ack) = shutdown_event_names(token);
        let open = |name: &str, access| -> windows::core::Result<OwnedHandle> {
            let wname = wide(name);
            let handle = unsafe { OpenEventW(access, false, PCWSTR(wname.as_ptr())) }?;
            OwnedHandle::new(handle).ok_or_else(windows::core::Error::from_thread)
        };
        Ok(HelperEnd {
            stop: open(&stop, SYNCHRONIZATION_SYNCHRONIZE)?,
            ack: open(&ack, EVENT_MODIFY_STATE)?,
        })
    }

    /// The stop event, for waits that must also wake on shutdown.
    pub fn stop_handle(&self) -> HANDLE {
        self.stop.get()
    }

    /// Whether the service has asked the helper to stop.
    pub fn stop_requested(&self) -> bool {
        self.wait_stop(Duration::ZERO)
    }

    /// Sleep up to `timeout`, returning early (true) if stop is signalled.
    pub fn wait_stop(&self, timeout: Duration) -> bool {
        unsafe { WaitForSingleObject(self.stop.get(), millis(timeout)) == WAIT_OBJECT_0 }
    }

    /// Tell the service every held input has been released and the helper is
    /// exiting. Called only after `release_all`.
    pub fn acknowledge(&self) {
        unsafe {
            let _ = SetEvent(self.ack.get());
        }
    }
}
