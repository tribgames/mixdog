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
//! Only ACEs that control access to the element itself are judged. An
//! inherit-only ACE (`INHERIT_ONLY_ACE`, SDDL `IO`) does not — stock `C:\` has
//! `(A;OICIIO;SDGXGWGR;;;AU)` — so it is skipped on the element that holds it.
//! It cannot be used to smuggle a grant in: a child receives it as an effective
//! (non-`IO`) ACE in the child's own DACL, and every element down to the file is
//! verified on its own DACL, inherited ACEs included.
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

use crate::security::{
    ace_controls_access, classify_ace_type, is_trusted_path_sid, mask_can_modify_path, AceClass, PathKind,
};
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
            verify_dacl(path, kind, dacl)
        })();

        if !descriptor.0.is_null() {
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        }
        result
    }
}

/// Judge the DACL of the path element `path` (of `kind`): no ACE that controls
/// access to the element may give path-modifying rights to an untrusted SID.
///
/// # Safety
/// `dacl` is null or points to a valid ACL that outlives the call.
unsafe fn verify_dacl(path: &Path, kind: PathKind, dacl: *const ACL) -> Result<(), String> {
    // A null DACL means "no protection" (everyone full control).
    if dacl.is_null() {
        return Err(format!("{} has no DACL", path.display()));
    }
    let ace_count = (*dacl).AceCount as u32;
    for index in 0..ace_count {
        let mut ace_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        // An ACE that cannot be read cannot be judged: fail closed rather than skip it.
        if GetAce(dacl, index, &mut ace_ptr).is_err() || ace_ptr.is_null() {
            return Err(format!(
                "{} has an unreadable ACE at index {index} that cannot be verified",
                path.display()
            ));
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
        // An inherit-only ACE does not control access to this element. Whatever
        // reaches a child through it is an effective ACE in the child's own
        // DACL, judged when the child is verified.
        if !ace_controls_access((*header).AceFlags) {
            continue;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use windows::core::BOOL;
    use windows::Win32::Foundation::WIN32_ERROR;
    use windows::Win32::Security::Authorization::SetNamedSecurityInfoW;
    use windows::Win32::Security::{
        GetSecurityDescriptorDacl, InitializeAcl, ACL_REVISION, INHERIT_ONLY_ACE as WINNT_INHERIT_ONLY_ACE,
        PROTECTED_DACL_SECURITY_INFORMATION,
    };
    use windows::Win32::Storage::FileSystem::CreateDirectoryW;

    use crate::security::INHERIT_ONLY_ACE;
    use crate::winutil::{current_user_sid, SecurityDescriptor};

    const DIR: PathKind = PathKind::Directory;

    /// The DACL inside a descriptor built from SDDL (valid while `descriptor` lives).
    fn dacl_of(descriptor: &SecurityDescriptor) -> *mut ACL {
        let mut present = BOOL(0);
        let mut defaulted = BOOL(0);
        let mut dacl: *mut ACL = std::ptr::null_mut();
        unsafe { GetSecurityDescriptorDacl(descriptor.raw(), &mut present, &mut dacl, &mut defaulted) }.unwrap();
        assert!(present.as_bool(), "the SDDL fixture has a DACL section");
        dacl
    }

    /// The verdict on the DACL `sddl` describes, for an element of `kind`.
    fn verdict(sddl: &str, kind: PathKind) -> Result<(), String> {
        let descriptor = SecurityDescriptor::from_sddl(sddl).unwrap();
        unsafe { verify_dacl(Path::new("fixture"), kind, dacl_of(&descriptor)) }
    }

    fn assert_untrusted(result: Result<(), String>, sid: &str) {
        let error = result.expect_err("an untrusted modify grant must be refused");
        assert!(
            error.ends_with(&format!("grants modify rights to untrusted SID {sid}")),
            "unexpected refusal: {error}"
        );
    }

    /// Trusted principals' ordinary ACEs on a directory.
    const TRUSTED: &str = "(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
    /// Authenticated Users "modify" (`SD|GX|GW|GR`, mask 0xE0010000): the stock
    /// `C:\` grant, which carries generic-write and delete — modify bits.
    const AU_MODIFY: &str = "SDGXGWGR;;;AU";

    #[test]
    fn the_inherit_only_flag_is_the_windows_one() {
        assert_eq!(INHERIT_ONLY_ACE as u32, WINNT_INHERIT_ONLY_ACE.0);
    }

    #[test]
    fn the_stock_windows_root_acl_is_trusted() {
        // `C:\` as Windows ships it (icacls: AU (OI)(CI)(IO)(M), AU (AD)). The
        // inherit-only grant is exactly what 1.4.0 refused; it would be a
        // modify grant to an untrusted SID if it controlled access to `C:\`.
        assert!(crate::security::mask_can_modify_path(0xE001_0000, DIR));
        let root = "D:PAI(A;OICIIO;GA;;;CO)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)\
                    (A;OICIIO;SDGXGWGR;;;AU)(A;;0x4;;;AU)";
        assert_eq!(verdict(root, DIR), Ok(()));
    }

    #[test]
    fn an_inherit_only_modify_grant_to_an_untrusted_sid_is_ignored() {
        for flags in ["OICIIO", "CIIO", "OIIO", "IO", "OICINPIO"] {
            let sddl = format!("D:P{TRUSTED}(A;{flags};{AU_MODIFY})");
            assert_eq!(verdict(&sddl, DIR), Ok(()), "flags {flags}");
        }
        // Wherever it sits among the ACEs, and for any untrusted grantee.
        for sddl in [
            format!("D:P(A;OICIIO;{AU_MODIFY}){TRUSTED}"),
            format!("D:P(A;OICIIO;GA;;;WD){TRUSTED}"),
            format!("D:P(A;OICIIO;GA;;;BU){TRUSTED}"),
        ] {
            assert_eq!(verdict(&sddl, DIR), Ok(()), "{sddl}");
        }
        // The same on a file element.
        assert_eq!(verdict("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;IO;FW;;;AU)", PathKind::File), Ok(()));
    }

    #[test]
    fn the_same_grant_that_applies_to_the_element_is_refused() {
        // Without IO the ACE is effective on this element, however it inherits.
        for flags in ["", "OI", "CI", "OICI", "OINP", "CINP"] {
            let sddl = format!("D:P{TRUSTED}(A;{flags};{AU_MODIFY})");
            assert_untrusted(verdict(&sddl, DIR), "S-1-5-11");
        }
        assert_untrusted(verdict("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FW;;;AU)", PathKind::File), "S-1-5-11");
        assert_untrusted(verdict(&format!("D:P{TRUSTED}(A;OICI;GA;;;BU)"), DIR), "S-1-5-32-545");
    }

    #[test]
    fn an_inherited_effective_grant_is_refused_but_an_inherited_inherit_only_one_is_not() {
        // INHERITED_ACE (SDDL `ID`) without IO: what a child holds after its
        // parent's `OICIIO` grant reached it. It controls access to the child.
        for flags in ["ID", "CIID", "OIID", "OICIID"] {
            let sddl = format!("D:AI{TRUSTED}(A;{flags};{AU_MODIFY})");
            assert_untrusted(verdict(&sddl, DIR), "S-1-5-11");
        }
        assert_untrusted(verdict("D:AI(A;;FA;;;SY)(A;;FA;;;BA)(A;ID;FW;;;AU)", PathKind::File), "S-1-5-11");
        // Inherited and still inherit-only (an OI-only grant that passed through a directory).
        let passing = format!("D:AI{TRUSTED}(A;OIIOID;{AU_MODIFY})");
        assert_eq!(verdict(&passing, DIR), Ok(()));
    }

    #[test]
    fn a_trusted_inherit_only_ace_changes_nothing() {
        let trusted_io = "(A;OICIIO;GA;;;SY)(A;OICIIO;GA;;;BA)(A;OICIIO;GA;;;CO)";
        let passing = format!("D:P{TRUSTED}");
        let failing = format!("D:P{TRUSTED}(A;OICI;{AU_MODIFY})");
        for (base, expected) in [(&passing, Ok(())), (&failing, verdict(&failing, DIR))] {
            let with_ace = format!("{base}{trusted_io}");
            assert_eq!(verdict(&with_ace, DIR), expected);
            let with_ace_first = format!("D:P{trusted_io}{}", base.trim_start_matches("D:P"));
            assert_eq!(verdict(&with_ace_first, DIR), expected);
        }
        assert_eq!(verdict(&passing, DIR), Ok(()));
        assert_untrusted(verdict(&failing, DIR), "S-1-5-11");
    }

    #[test]
    fn skipping_an_inherit_only_ace_does_not_hide_the_ones_after_it() {
        // Per ACE, not per DACL: an effective untrusted grant behind an IO one is still found.
        let sddl = format!("D:P{TRUSTED}(A;OICIIO;{AU_MODIFY})(A;;GA;;;BU)");
        assert_untrusted(verdict(&sddl, DIR), "S-1-5-32-545");
        // A deny ACE is skipped as before, and an inherit-only deny changes nothing either.
        let denied = format!("D:P{TRUSTED}(D;OICIIO;GA;;;AU)(D;;GA;;;BU)");
        assert_eq!(verdict(&denied, DIR), Ok(()));
    }

    #[test]
    fn everything_else_stays_strict() {
        // Unreadable layouts still fail closed — inherit-only or not.
        for flags in ["OICI", "OICIIO"] {
            let object_ace = format!("D:P{TRUSTED}(OA;{flags};CC;bf967aba-0de6-11d0-a285-00aa003049e2;;AU)");
            let error = verdict(&object_ace, DIR).unwrap_err();
            assert!(error.ends_with("has an unsupported ACE type 5 that cannot be verified"), "{error}");
        }
        // A null DACL is "no protection".
        let error = verdict("D:NO_ACCESS_CONTROL", DIR).unwrap_err();
        assert!(error.ends_with("has no DACL"), "{error}");
        // Create-only rights stay benign on a directory.
        assert_eq!(verdict(&format!("D:P{TRUSTED}(A;OICI;0x6;;;AU)"), DIR), Ok(()));
    }

    #[test]
    fn an_ace_that_cannot_be_read_fails_closed() {
        // An ACL header claiming more ACEs than its size holds (the 8-byte header
        // alone): `GetAce` fails for every index. The entry must be refused, not skipped.
        let mut buffer = [0u32; 2];
        let acl = buffer.as_mut_ptr().cast::<ACL>();
        unsafe {
            InitializeAcl(acl, std::mem::size_of_val(&buffer) as u32, ACL_REVISION).unwrap();
            // Control: the same well-formed, empty ACL has nothing to refuse.
            assert_eq!(verify_dacl(Path::new("fixture"), DIR, acl), Ok(()));
            (*acl).AceCount = 2;
            let error = verify_dacl(Path::new("fixture"), DIR, acl).unwrap_err();
            assert_eq!(error, "fixture has an unreadable ACE at index 0 that cannot be verified");
        }
    }

    // ---- real on-disk ACLs, on directories created in %TEMP% only -------------

    /// Set (and, when `protected`, protect) the DACL of `path` from `sddl`.
    fn set_dacl(path: &Path, sddl: &str, protected: bool) -> WIN32_ERROR {
        let descriptor = SecurityDescriptor::from_sddl(sddl).unwrap();
        let dacl = dacl_of(&descriptor);
        let wide_path = wide(&path.to_string_lossy());
        let mut info = DACL_SECURITY_INFORMATION.0;
        if protected {
            info |= PROTECTED_DACL_SECURITY_INFORMATION.0;
        }
        unsafe {
            SetNamedSecurityInfoW(
                PCWSTR(wide_path.as_ptr()),
                SE_FILE_OBJECT,
                OBJECT_SECURITY_INFORMATION(info),
                None,
                None,
                Some(dacl.cast_const()),
                None,
            )
        }
    }

    /// Create `path` born with the DACL `sddl` describes (as the installer does).
    fn create_dir_with(path: &Path, sddl: &str) {
        let descriptor = SecurityDescriptor::from_sddl(sddl).unwrap();
        let attributes = descriptor.attributes();
        let wide_path = wide(&path.to_string_lossy());
        unsafe { CreateDirectoryW(PCWSTR(wide_path.as_ptr()), Some(&attributes)) }.unwrap();
    }

    /// The DACL of `path` as it is on disk, judged like `verify_element` does
    /// once the owner passed (the owner of a test directory is the running
    /// user, which is untrusted by design).
    fn disk_verdict(path: &Path, kind: PathKind) -> Result<(), String> {
        let wide_path = wide(&path.to_string_lossy());
        unsafe {
            let mut dacl: *mut ACL = std::ptr::null_mut();
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            let status = GetNamedSecurityInfoW(
                PCWSTR(wide_path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut dacl),
                None,
                &mut descriptor,
            );
            assert_eq!(status, ERROR_SUCCESS);
            let result = verify_dacl(path, kind, dacl);
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            result
        }
    }

    /// A fresh directory under `%TEMP%` plus the subdirectories made in it. The
    /// ACLs under test lock the running user out of everything but ownership,
    /// so on drop the user (the owner) is given full control back, then the
    /// tree is removed. Nothing outside it is ever touched.
    struct TempTree {
        root: PathBuf,
        dirs: Vec<PathBuf>,
    }

    impl TempTree {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("mixdog-sd-acl-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir(&root).unwrap();
            TempTree { root, dirs: Vec::new() }
        }

        fn track(&mut self, dir: PathBuf) -> PathBuf {
            self.dirs.push(dir.clone());
            dir
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            if let Ok(user) = current_user_sid() {
                let open = format!("D:P(A;OICI;FA;;;{user})");
                for dir in std::iter::once(&self.root).chain(&self.dirs) {
                    let _ = set_dacl(dir, &open, true);
                }
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn on_disk_an_inherit_only_grant_is_ignored_on_its_directory_and_counted_where_it_is_inherited() {
        let user = current_user_sid().unwrap();
        let mut tree = TempTree::new("inherit");
        // The ancestor, like a stock root: trusted principals, plus an
        // inherit-only Authenticated Users "modify" for new children. The
        // running user keeps create-subdirectory only (benign on a directory)
        // so the test can make children below it.
        let ancestor = format!("D:P{TRUSTED}(A;OICIIO;{AU_MODIFY})(A;;0x6;;;{user})");
        assert_eq!(set_dacl(&tree.root, &ancestor, true), ERROR_SUCCESS);
        assert_eq!(disk_verdict(&tree.root, DIR), Ok(()), "the ancestor itself");

        // A child made the ordinary way receives that grant as its own effective ACE.
        let inheriting = tree.track(tree.root.join("inheriting"));
        std::fs::create_dir(&inheriting).unwrap();
        assert_untrusted(disk_verdict(&inheriting, DIR), "S-1-5-11");

        // A child born with a protected DACL (what the installer creates) receives nothing.
        let sealed = tree.track(tree.root.join("sealed"));
        create_dir_with(&sealed, &format!("D:P{TRUSTED}"));
        assert_eq!(disk_verdict(&sealed, DIR), Ok(()), "a protected child");
    }

    #[test]
    fn on_disk_an_inherit_only_grant_gives_its_holder_no_access_to_the_object_it_is_on() {
        let user = current_user_sid().unwrap();
        for flags in ["OICIIO", "IO"] {
            let tree = TempTree::new("noaccess");
            let made = tree.root.join("made");
            assert_eq!(set_dacl(&tree.root, &format!("D:P(A;{flags};FA;;;{user})"), true), ERROR_SUCCESS);
            let denied = std::fs::create_dir(&made).unwrap_err();
            assert_eq!(denied.kind(), std::io::ErrorKind::PermissionDenied, "{flags}: {denied}");
            // The same grant without IO does open the directory.
            assert_eq!(set_dacl(&tree.root, &format!("D:P(A;OICI;FA;;;{user})"), true), ERROR_SUCCESS);
            std::fs::create_dir(&made).unwrap();
        }
    }
}
