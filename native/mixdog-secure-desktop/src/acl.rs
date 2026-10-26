//! Trusted-path verification for the install location.
//!
//! The service runs the binary at a fixed path as LocalSystem, so that path —
//! and every directory leading to it — must be modifiable only by trusted
//! principals (SYSTEM, Administrators, TrustedInstaller). If the installing
//! user, or any other non-admin principal, could replace the file or redirect a
//! parent directory, they would gain SYSTEM code execution. This module checks,
//! before the service is registered, that:
//!
//! * no element of the path is a reparse point (no symlink/junction redirection), and
//! * every element is owned by a trusted SID and grants path-modifying rights
//!   (delete, delete-child, write-DAC/owner, generic write/all) only to trusted SIDs.
//!
//! It reads the real on-disk security of each element with `GetNamedSecurityInfoW`;
//! the SID/mask policy itself lives in [`crate::security`] and is unit-tested there.

use std::path::Path;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
use windows::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, ConvertSidToStringSidW, SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    GetAce, ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION, OBJECT_SECURITY_INFORMATION,
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
};
use windows::Win32::Storage::FileSystem::{
    GetFileAttributesW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    INVALID_FILE_ATTRIBUTES,
};

use crate::security::{classify_ace_type, is_trusted_path_sid, mask_can_modify_path, AceClass, PathKind};
use crate::winutil::wide;

/// Convert a raw `PSID` to its string form, or `None` if it is null/invalid.
unsafe fn sid_to_string(sid: PSID) -> Option<String> {
    if sid.0.is_null() {
        return None;
    }
    let mut text = PWSTR::null();
    ConvertSidToStringSidW(sid, &mut text).ok()?;
    let value = text.to_string().ok();
    let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
    value
}

/// Verify one path element: not a reparse point, owned by a trusted SID, and
/// granting path-modifying rights only to trusted SIDs.
fn verify_element(path: &Path) -> Result<(), String> {
    let wide_path = wide(&path.to_string_lossy());

    // Reject symlinks/junctions: a reparse point could redirect the path to
    // user-controlled storage after this check would otherwise pass.
    let attributes = unsafe { GetFileAttributesW(PCWSTR(wide_path.as_ptr())) };
    if attributes == INVALID_FILE_ATTRIBUTES {
        return Err(format!("cannot read attributes of {}", path.display()));
    }
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(format!("{} is a reparse point", path.display()));
    }
    // A file and a directory interpret access bits 0x02/0x04 differently, so
    // the modify policy is selected by the element's real kind.
    let kind = if attributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0 {
        PathKind::Directory
    } else {
        PathKind::File
    };

    unsafe {
        let mut owner = PSID(std::ptr::null_mut());
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let status = GetNamedSecurityInfoW(
            PCWSTR(wide_path.as_ptr()),
            SE_FILE_OBJECT,
            OBJECT_SECURITY_INFORMATION(
                OWNER_SECURITY_INFORMATION.0 | DACL_SECURITY_INFORMATION.0,
            ),
            Some(&mut owner),
            None,
            Some(&mut dacl),
            None,
            &mut descriptor,
        );
        if status != ERROR_SUCCESS {
            return Err(format!(
                "cannot read security of {} (error {})",
                path.display(),
                status.0
            ));
        }

        // Everything below runs before the single LocalFree, so hold the result.
        let result = (|| -> Result<(), String> {
            let owner_sid = sid_to_string(owner)
                .ok_or_else(|| format!("{} has no readable owner", path.display()))?;
            if !is_trusted_path_sid(&owner_sid) {
                return Err(format!("{} is owned by untrusted SID {owner_sid}", path.display()));
            }
            // A null DACL means "no protection" (everyone full control).
            if dacl.is_null() {
                return Err(format!("{} has no DACL", path.display()));
            }
            let ace_count = (*dacl).AceCount as u32;
            for index in 0..ace_count {
                let mut ace_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
                if GetAce(dacl, index, &mut ace_ptr).is_err() || ace_ptr.is_null() {
                    continue;
                }
                let header = ace_ptr as *const windows::Win32::Security::ACE_HEADER;
                match classify_ace_type((*header).AceType) {
                    // Deny ACEs only reduce access; safe to skip.
                    AceClass::Deny => continue,
                    // An object/callback allow or unknown ACE does not have its
                    // SID at the plain `ACCESS_ALLOWED_ACE` offset, so we cannot
                    // read the grantee. Fail closed rather than ignore it.
                    AceClass::Unsupported => {
                        return Err(format!(
                            "{} has an unsupported ACE type {} that cannot be verified",
                            path.display(),
                            (*header).AceType
                        ));
                    }
                    AceClass::Allow => {}
                }
                let ace = ace_ptr as *const ACCESS_ALLOWED_ACE;
                if !mask_can_modify_path((*ace).Mask, kind) {
                    continue;
                }
                let sid = PSID(&(*ace).SidStart as *const u32 as *mut core::ffi::c_void);
                let sid_string = sid_to_string(sid).unwrap_or_default();
                if !is_trusted_path_sid(&sid_string) {
                    return Err(format!(
                        "{} grants modify rights to untrusted SID {sid_string}",
                        path.display()
                    ));
                }
            }
            Ok(())
        })();

        if !descriptor.0.is_null() {
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        }
        result
    }
}

/// Verify `path` and every ancestor up to the drive root. Fails closed: any
/// element that cannot be read, is a reparse point, or is modifiable by an
/// untrusted principal aborts the install.
pub fn verify_trusted_ancestry(path: &Path) -> Result<(), String> {
    for element in path.ancestors() {
        // `ancestors()` ends with "" for relative inputs; our paths are
        // absolute, so the final element is the drive root (e.g. `C:\`).
        if element.as_os_str().is_empty() {
            continue;
        }
        verify_element(element)?;
    }
    Ok(())
}
