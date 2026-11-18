//! The admission word an unelevated authority shares with its elevated worker: one 8-byte pagefile-backed section the parent
//! creates before the launch, so the parent's revocation closes the worker's admission itself (one atomic `fetch_or`), with no
//! supervisor, file or poll in between. Layout and operations: `crate::port::word`, `grant_word`, `close_word`.
//!
//! The section is named `Local\mixdog-admission-<token>` with the launch's secret token (authenticated by the existing launch
//! handshake), created only fresh (an existing object of that name is rejected), with an explicit DACL: full access for the
//! parent's user and for Administrators (an elevation to another administrator), nothing for anyone else, at medium integrity
//! (no Low writer). A child that cannot open it never gets a word, so it is never granted.

use crate::port::AdmissionWord;
use std::sync::atomic::AtomicU64;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, SetLastError, ERROR_ALREADY_EXISTS, HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_READ, FILE_MAP_WRITE,
    MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const SIZE: usize = 8;

/// One mapped admission word.
pub(crate) struct SharedWord {
    mapping: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
}

// SAFETY: the view is a page-aligned, process-lifetime mapping used only through an `AtomicU64`.
unsafe impl Send for SharedWord {}
// SAFETY: as above.
unsafe impl Sync for SharedWord {}

impl AdmissionWord for SharedWord {
    fn word(&self) -> &AtomicU64 {
        // SAFETY: the view is mapped for this value's life, page aligned, and at least 8 bytes long.
        unsafe { &*(self.view.Value as *const AtomicU64) }
    }
}

impl Drop for SharedWord {
    fn drop(&mut self) {
        // SAFETY: both were opened by this value and are released once.
        unsafe {
            let _ = UnmapViewOfFile(self.view);
            let _ = CloseHandle(self.mapping);
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The section's name for a launch token.
pub(crate) fn name(token: &str) -> String {
    format!("Local\\mixdog-admission-{token}")
}

/// This process's user SID as text.
fn user_sid() -> Result<String, String> {
    // SAFETY: a token of this process, queried into a buffer of the size it asks for; the string is freed with LocalFree.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(|error| error.to_string())?;
        let mut size = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut size);
        let mut buffer = vec![0u8; size as usize];
        let read = GetTokenInformation(token, TokenUser, Some(buffer.as_mut_ptr().cast()), size, &mut size);
        let _ = CloseHandle(token);
        read.map_err(|error| error.to_string())?;
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text).map_err(|error| error.to_string())?;
        let sid = text.to_string().map_err(|error| error.to_string());
        let _ = LocalFree(Some(HLOCAL(text.0.cast())));
        sid
    }
}

fn map(mapping: HANDLE) -> Result<SharedWord, String> {
    // SAFETY: a valid mapping handle; a view that fails leaves the handle to be closed here.
    unsafe {
        let view = MapViewOfFile(mapping, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, SIZE);
        if view.Value.is_null() {
            let _ = CloseHandle(mapping);
            return Err("privileged_worker_unavailable: the admission section could not be mapped".into());
        }
        Ok(SharedWord { mapping, view })
    }
}

/// Creates the section fresh (pending: nothing admitted until granted), before the worker is launched.
pub(crate) fn create(token: &str) -> Result<SharedWord, String> {
    let sddl = wide(&format!("D:P(A;;GA;;;{})(A;;GA;;;BA)S:(ML;;NW;;;ME)", user_sid()?));
    let name = wide(&name(token));
    // SAFETY: NUL-terminated strings; the descriptor is freed with LocalFree once the section exists.
    unsafe {
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(sddl.as_ptr()), SDDL_REVISION_1, &mut descriptor, None)
            .map_err(|error| error.to_string())?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        SetLastError(Default::default());
        let mapping =
            CreateFileMappingW(INVALID_HANDLE_VALUE, Some(&attributes), PAGE_READWRITE, 0, SIZE as u32, PCWSTR(name.as_ptr()));
        let existed = GetLastError() == ERROR_ALREADY_EXISTS;
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        let mapping = mapping.map_err(|error| format!("privileged_worker_unavailable: admission section: {error}"))?;
        if existed {
            let _ = CloseHandle(mapping);
            return Err("privileged_worker_rejected: an admission section of this name already existed".into());
        }
        map(mapping)
    }
}

/// Opens the section the parent created; an error means no word, and so no grant.
pub(crate) fn open(token: &str) -> Result<SharedWord, String> {
    let name = wide(&name(token));
    // SAFETY: a NUL-terminated name.
    let mapping = unsafe { OpenFileMappingW((FILE_MAP_READ | FILE_MAP_WRITE).0, false, PCWSTR(name.as_ptr())) }
        .map_err(|error| format!("privileged_worker_rejected: admission section: {error}"))?;
    map(mapping)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::{close_word, grant_word, word};
    use std::sync::atomic::Ordering;

    /// Created fresh, opened by the child, granted, closed by the parent alone: the child sees the closure; a second creation
    /// of the same name is rejected.
    #[test]
    fn the_parent_closes_the_word_the_child_maps() {
        let token = format!("test-{}-{}", std::process::id(), line!());
        let parent = create(&token).unwrap();
        assert!(create(&token).is_err(), "a pre-existing object is rejected");
        let child = open(&token).unwrap();
        assert!(grant_word(parent.word()));
        assert_eq!(child.word().load(Ordering::SeqCst), word::OPEN);
        child.word().fetch_add(word::HAND_OVER, Ordering::SeqCst);
        assert_eq!(close_word(parent.word()), 1);
        assert!(child.word().load(Ordering::SeqCst) & word::CLOSED != 0);
        assert!(!grant_word(parent.word()), "a late grant never reopens it");
    }
}
