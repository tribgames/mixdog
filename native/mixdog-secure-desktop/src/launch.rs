//! Launch the session helper as SYSTEM inside the active console session, on a
//! chosen desktop.
//!
//! The service runs as LocalSystem. To put a SYSTEM process in the interactive
//! session it duplicates its own token into a primary token, retargets that
//! duplicate's session id to the active console session, and calls
//! `CreateProcessAsUserW` with `lpDesktop = "winsta0\default"`. Running the
//! helper as SYSTEM (rather than the logged-in user) is deliberate: only a
//! SYSTEM process in the console session may attach to the `Winlogon` desktop,
//! which is the whole point of capturing UAC and the lock screen. The privilege
//! enables are the ones `CreateProcessAsUser` with a session-retargeted token
//! requires; LocalSystem holds them, so enabling only switches them on.

use std::os::windows::ffi::OsStrExt;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, LUID};
use windows::Win32::Security::{
    AdjustTokenPrivileges, DuplicateTokenEx, LookupPrivilegeValueW, SetTokenInformation,
    SecurityImpersonation, TokenPrimary, TokenSessionId, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
    SE_ASSIGNPRIMARYTOKEN_NAME, SE_INCREASE_QUOTA_NAME, SE_TCB_NAME, TOKEN_ADJUST_DEFAULT,
    TOKEN_ADJUST_SESSIONID, TOKEN_ALL_ACCESS, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
    TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetCurrentProcess, OpenProcessToken, CREATE_NO_WINDOW, DETACHED_PROCESS,
    PROCESS_INFORMATION, STARTUPINFOW,
};

use crate::winutil::OwnedHandle;

/// The ordinary interactive desktop.
pub const DESKTOP_DEFAULT: &str = r"winsta0\default";

fn wide_z(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn enable_privilege(token: HANDLE, name: PCWSTR) {
    unsafe {
        let mut luid = LUID::default();
        if LookupPrivilegeValueW(PCWSTR::null(), name, &mut luid).is_err() {
            return;
        }
        let privileges = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        // Best effort: LocalSystem already holds these; a failure here is not
        // fatal and the subsequent CreateProcessAsUser surfaces any real
        // shortfall.
        let _ = AdjustTokenPrivileges(token, false, Some(&privileges), 0, None, None);
    }
}

/// Launch this executable again with `args`, as SYSTEM, in `session_id`, on
/// `desktop` (`winsta0\default` or `winsta0\winlogon`). Returns the process
/// handle so the service can monitor and terminate it.
pub fn launch_in_session(
    session_id: u32,
    desktop: &str,
    args: &[&str],
) -> windows::core::Result<OwnedHandle> {
    let exe = std::env::current_exe().map_err(|_| windows::core::Error::from_thread())?;
    let exe = exe.to_string_lossy().to_string();

    unsafe {
        let mut raw_token = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE
                | TOKEN_QUERY
                | TOKEN_ASSIGN_PRIMARY
                | TOKEN_ADJUST_DEFAULT
                | TOKEN_ADJUST_SESSIONID,
            &mut raw_token,
        )?;
        let token = OwnedHandle::new(raw_token).ok_or_else(windows::core::Error::from_thread)?;

        enable_privilege(token.get(), SE_TCB_NAME);
        enable_privilege(token.get(), SE_ASSIGNPRIMARYTOKEN_NAME);
        enable_privilege(token.get(), SE_INCREASE_QUOTA_NAME);

        let mut raw_dup = HANDLE::default();
        DuplicateTokenEx(
            token.get(),
            TOKEN_ALL_ACCESS,
            None,
            SecurityImpersonation,
            TokenPrimary,
            &mut raw_dup,
        )?;
        let dup = OwnedHandle::new(raw_dup).ok_or_else(windows::core::Error::from_thread)?;

        let session = session_id;
        SetTokenInformation(
            dup.get(),
            TokenSessionId,
            &session as *const u32 as *const core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )?;

        let mut command = format!("\"{exe}\"");
        for arg in args {
            command.push(' ');
            command.push_str(arg);
        }
        let mut command_wide = wide_z(&command);
        let mut desktop_wide = wide_z(desktop);

        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            lpDesktop: PWSTR(desktop_wide.as_mut_ptr()),
            ..Default::default()
        };
        let mut info = PROCESS_INFORMATION::default();

        CreateProcessAsUserW(
            Some(dup.get()),
            PCWSTR::null(),
            Some(PWSTR(command_wide.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_NO_WINDOW | DETACHED_PROCESS,
            None,
            PCWSTR::null(),
            &startup,
            &mut info,
        )?;

        let _ = CloseHandle(info.hThread);
        OwnedHandle::new(info.hProcess).ok_or_else(windows::core::Error::from_thread)
    }
}
