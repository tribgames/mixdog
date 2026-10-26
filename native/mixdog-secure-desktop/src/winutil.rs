//! Small Windows helpers shared by the privileged paths: owned HANDLE/HDESK
//! guards, wide-string conversion, a security descriptor built from an SDDL
//! string, and the current process's user SID. Everything that touches raw
//! Win32 lives behind these so the higher-level modules stay readable.

use std::time::{SystemTime, UNIX_EPOCH};

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
};
use windows::Win32::Security::{
    GetTokenInformation, RevertToSelf, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
    TOKEN_USER, TokenUser,
};
use windows::Win32::System::Pipes::ImpersonateNamedPipeClient;
use windows::Win32::System::RemoteDesktop::WTSQueryUserToken;
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, HDESK};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, OpenProcess, OpenProcessToken, OpenThreadToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

/// `true` if a Win32 call's error carries this plain Win32 error code (the
/// error is stored as `HRESULT_FROM_WIN32`, i.e. `0x8007_0000 | code`).
pub fn is_win32_error(error: &windows::core::Error, code: u32) -> bool {
    error.code().0 as u32 == (0x8007_0000 | (code & 0xFFFF))
}

/// A null-terminated UTF-16 string for passing to the `W` Win32 APIs.
pub fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Owns a HANDLE and closes it on drop. Construction rejects the null and
/// invalid sentinels so callers never guard a non-handle.
pub struct OwnedHandle(HANDLE);

impl OwnedHandle {
    pub fn new(handle: HANDLE) -> Option<Self> {
        if handle.is_invalid() {
            None
        } else {
            Some(OwnedHandle(handle))
        }
    }

    pub fn get(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// Owns an HDESK and closes it on drop.
pub struct OwnedDesktop(HDESK);

impl OwnedDesktop {
    pub fn new(desktop: HDESK) -> Option<Self> {
        if desktop.is_invalid() {
            None
        } else {
            Some(OwnedDesktop(desktop))
        }
    }

    pub fn get(&self) -> HDESK {
        self.0
    }
}

impl Drop for OwnedDesktop {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseDesktop(self.0);
        }
    }
}

/// A self-relative security descriptor allocated by the SDDL converter. Holds
/// the allocation so a [`SECURITY_ATTRIBUTES`] built from it stays valid, and
/// frees it with `LocalFree` on drop.
pub struct SecurityDescriptor {
    descriptor: PSECURITY_DESCRIPTOR,
}

impl SecurityDescriptor {
    /// Parse an SDDL string (e.g. `D:P(A;;GA;;;SY)...`) into a descriptor.
    pub fn from_sddl(sddl: &str) -> windows::core::Result<Self> {
        let wide_sddl = wide(sddl);
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                windows::core::PCWSTR(wide_sddl.as_ptr()),
                1, // SDDL_REVISION_1
                &mut descriptor,
                None,
            )?;
        }
        Ok(SecurityDescriptor { descriptor })
    }

    /// The raw descriptor pointer, valid for as long as `self` lives. Used by
    /// callers that pass a `PSECURITY_DESCRIPTOR` directly (SetFileSecurityW,
    /// SetServiceObjectSecurity).
    pub fn raw(&self) -> PSECURITY_DESCRIPTOR {
        self.descriptor
    }

    /// A SECURITY_ATTRIBUTES referencing this descriptor. The returned value
    /// borrows `self`, so the descriptor outlives every use of the attributes.
    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.0,
            bInheritHandle: false.into(),
        }
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        if !self.descriptor.0.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.descriptor.0)));
            }
        }
    }
}

/// The string SID of the user a token belongs to. Shared by every SID lookup
/// below so the `GetTokenInformation(TokenUser)` + `ConvertSidToStringSidW`
/// dance lives in one place.
unsafe fn token_user_sid(token: HANDLE) -> windows::core::Result<String> {
    let mut needed = 0u32;
    // First call sizes the buffer; it is expected to fail with
    // ERROR_INSUFFICIENT_BUFFER, so its result is intentionally ignored.
    let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
    if needed == 0 {
        return Err(windows::core::Error::from_thread());
    }
    let mut buffer = vec![0u8; needed as usize];
    GetTokenInformation(
        token,
        TokenUser,
        Some(buffer.as_mut_ptr() as *mut _),
        needed,
        &mut needed,
    )?;

    let token_user = &*(buffer.as_ptr() as *const TOKEN_USER);
    let mut string_sid = PWSTR::null();
    ConvertSidToStringSidW(token_user.User.Sid, &mut string_sid)?;
    let sid = string_sid
        .to_string()
        .map_err(|_| windows::core::Error::from_thread())?;
    let _ = LocalFree(Some(HLOCAL(string_sid.0 as *mut _)));
    Ok(sid)
}

/// The string SID (`S-1-5-...`) of the user running this process. For an
/// elevated install this is still the consenting user, not SYSTEM, because
/// elevation raises integrity without changing the token's user.
pub fn current_user_sid() -> windows::core::Result<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)?;
        let token = OwnedHandle::new(token).ok_or_else(windows::core::Error::from_thread)?;
        token_user_sid(token.get())
    }
}

/// The SID of the user logged on to `session_id`'s console, or `None` when the
/// session has no interactive user token — which is exactly the case at the
/// logon / sign-in screen, where `Winlogon` owns the desktop and no user is
/// signed in. Requires `SeTcbPrivilege`, which the SYSTEM service and helper
/// hold; callers running as a plain user get `None`.
pub fn session_user_sid(session_id: u32) -> Option<String> {
    unsafe {
        let mut raw = HANDLE::default();
        WTSQueryUserToken(session_id, &mut raw).ok()?;
        let token = OwnedHandle::new(raw)?;
        token_user_sid(token.get()).ok()
    }
}

/// The SID of the user a connected pipe client runs as, obtained by briefly
/// impersonating the client. Always reverts to self before returning, even on
/// error, so the helper thread never keeps the client's identity.
pub fn client_user_sid(pipe: HANDLE) -> Option<String> {
    unsafe {
        ImpersonateNamedPipeClient(pipe).ok()?;
        let result = (|| -> windows::core::Result<String> {
            let mut raw = HANDLE::default();
            OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, &mut raw)?;
            let token = OwnedHandle::new(raw).ok_or_else(windows::core::Error::from_thread)?;
            token_user_sid(token.get())
        })();
        let _ = RevertToSelf();
        result.ok()
    }
}

/// The SID of the user a process runs as, by pid. Used by the client to confirm
/// the pipe server process is SYSTEM before trusting it with the secret.
pub fn process_user_sid(pid: u32) -> Option<String> {
    unsafe {
        let process = OwnedHandle::new(
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?,
        )?;
        let mut raw = HANDLE::default();
        OpenProcessToken(process.get(), TOKEN_QUERY, &mut raw).ok()?;
        let token = OwnedHandle::new(raw)?;
        token_user_sid(token.get()).ok()
    }
}
