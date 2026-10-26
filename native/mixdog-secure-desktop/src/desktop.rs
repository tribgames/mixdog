//! Attaching the calling thread to the current input desktop and naming it.
//!
//! A LocalSystem process in the console session can open and switch to whichever
//! desktop currently receives input — the ordinary `Default` desktop, or the
//! `Winlogon` secure desktop that hosts UAC consent, the lock screen, and the
//! sign-in screen. A plain user process cannot touch `Winlogon`; running the
//! helper as SYSTEM is what makes the secure desktop reachable at all.
//!
//! The helper calls [`attach_to_input_desktop`] before capturing or injecting,
//! and re-attaches whenever [`input_desktop_name`] reports a different desktop.
//! Capture (GDI) and injection (`SendInput`) both act on the thread's attached
//! desktop, so this attach is the pivot that follows the input across the UAC
//! transition and back.

use windows::core::PWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::RemoteDesktop::{
    WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW, WTS_SESSIONSTATE_LOCK,
    WTS_SESSIONSTATE_UNLOCK,
};
use windows::Win32::System::StationsAndDesktops::{
    GetUserObjectInformationW, OpenInputDesktop, SetThreadDesktop, DESKTOP_ACCESS_FLAGS,
    DESKTOP_CREATEMENU, DESKTOP_CREATEWINDOW, DESKTOP_ENUMERATE, DESKTOP_HOOKCONTROL,
    DESKTOP_READOBJECTS, DESKTOP_SWITCHDESKTOP, DESKTOP_WRITEOBJECTS, DESKTOP_CONTROL_FLAGS,
    UOI_NAME,
};

use crate::protocol::MAX_DESKTOP_NAME;
use crate::winutil::OwnedDesktop;

fn input_access() -> DESKTOP_ACCESS_FLAGS {
    // DESKTOP_ACCESS_FLAGS does not implement BitOr in this windows version, so
    // the access mask is composed from the raw bits.
    DESKTOP_ACCESS_FLAGS(
        DESKTOP_READOBJECTS.0
            | DESKTOP_WRITEOBJECTS.0
            | DESKTOP_SWITCHDESKTOP.0
            | DESKTOP_CREATEWINDOW.0
            | DESKTOP_CREATEMENU.0
            | DESKTOP_HOOKCONTROL.0
            | DESKTOP_ENUMERATE.0,
    )
}

fn object_name(handle: HANDLE) -> Option<String> {
    // The wire contract bounds a reported name by this buffer's size.
    let mut buffer = [0u16; MAX_DESKTOP_NAME];
    let mut needed = 0u32;
    unsafe {
        GetUserObjectInformationW(
            handle,
            UOI_NAME,
            Some(buffer.as_mut_ptr() as *mut _),
            (buffer.len() * std::mem::size_of::<u16>()) as u32,
            Some(&mut needed),
        )
        .ok()?;
    }
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

/// Name of the desktop currently receiving input, read without switching to it.
/// The name is reported to the app verbatim (`Default`, `Winlogon`, …): UAC
/// consent, Ctrl+Alt+Del, and the lock / sign-in screen all render on the one
/// `Winlogon` desktop, so there is no separate "locked" desktop to report.
/// Comparing this against the attached desktop detects a UAC / lock transition.
pub fn input_desktop_name() -> Option<String> {
    let desktop = unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, input_access()).ok()? };
    let owned = OwnedDesktop::new(desktop)?;
    object_name(HANDLE(owned.get().0))
}

/// Whether `session` is locked, from WTS's own session flags
/// (`WTSQuerySessionInformationW(WTSSessionInfoEx)` →
/// `WTSINFOEX_LEVEL1_W.SessionFlags`,
/// https://learn.microsoft.com/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w):
/// `WTS_SESSIONSTATE_LOCK` locked, `WTS_SESSIONSTATE_UNLOCK` unlocked, and
/// `None` for `WTS_SESSIONSTATE_UNKNOWN` or a failed query. This tells the
/// lock / sign-in screen apart from UAC consent, which share the `Winlogon`
/// desktop. (The same page notes the two flags are swapped on Windows 7 /
/// Server 2008 R2; the app requires Windows 10 or later.)
pub fn session_locked(session: u32) -> Option<bool> {
    unsafe {
        let mut buffer = PWSTR::null();
        let mut bytes = 0u32;
        WTSQuerySessionInformationW(None, session, WTSSessionInfoEx, &mut buffer, &mut bytes).ok()?;
        let info = (bytes as usize >= std::mem::size_of::<WTSINFOEXW>())
            .then(|| *(buffer.0 as *const WTSINFOEXW));
        WTSFreeMemory(buffer.0 as *mut _);
        let info = info.filter(|info| info.Level == 1)?;
        match info.Data.WTSInfoExLevel1.SessionFlags as u32 {
            WTS_SESSIONSTATE_LOCK => Some(true),
            WTS_SESSIONSTATE_UNLOCK => Some(false),
            _ => None,
        }
    }
}

/// Open the input desktop and switch the calling thread onto it. The returned
/// [`OwnedDesktop`] must be kept alive for as long as the thread stays attached;
/// dropping it closes the handle (the thread keeps the desktop until it attaches
/// elsewhere). Returns the desktop's name alongside the handle; a desktop whose
/// name cannot be read is an attach failure, since the app is always told which
/// desktop it is looking at.
pub fn attach_to_input_desktop() -> windows::core::Result<(OwnedDesktop, String)> {
    unsafe {
        let desktop = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, input_access())?;
        let owned = OwnedDesktop::new(desktop)
            .ok_or_else(windows::core::Error::from_thread)?;
        SetThreadDesktop(owned.get())?;
        let name = object_name(HANDLE(owned.get().0))
            .filter(|name| !name.is_empty())
            .ok_or_else(windows::core::Error::from_thread)?;
        Ok((owned, name))
    }
}
