//! Who may open a new file, set when the file is created so there is no readable window, and
//! the directory sync the publish path asks for.

use std::io;
use std::path::Path;

use mixdog_fsio::File;
use mixdog_fsio::OpenOptions;
use mixdog_fsio::ReadProof;
use mixdog_fsio::WriteProof;
use mixdog_rt::InLane;

use crate::IoLane;
use crate::WriteLane;

/// Who may open a new file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// The directory's defaults (inherited ACL; on Unix the mode the caller names).
    Inherit,
    /// The current user only: Unix mode 0600 in the `open` call; Windows a protected DACL with
    /// one full-access entry for the current user's SID.
    OwnerOnly,
}

/// Creates `path`, which must not exist, with `access`. `unix_mode` applies to `Inherit` on
/// Unix; elsewhere it is ignored.
pub fn create_new<L: WriteLane>(_lane: &InLane<L>, path: &Path, access: Access, unix_mode: u32) -> io::Result<File> {
    create_new_platform(_lane, path, access, unix_mode)
}

/// The same three primitives without a lane proof, for `mixdog_store::fsio` alone: its
/// `create_new_file`, `is_owner_only` and `sync_dir` are entry points that migration and remote
/// code call from their own threads, outside the lane contract. Every other caller uses the
/// lane-proofed functions.
// Hidden from the docs so it is not mistaken for API: `mixdog_store::fsio` is the only caller.
#[doc(hidden)]
pub mod unlaned {
    use std::io;
    use std::path::Path;

    use mixdog_fsio::File;
    use mixdog_fsio::Unlaned;

    use super::Access;

    /// [`super::create_new`].
    pub fn create_new(path: &Path, access: Access, unix_mode: u32) -> io::Result<File> {
        super::create_new_platform(&Unlaned, path, access, unix_mode)
    }

    /// [`super::is_owner_only`].
    pub fn is_owner_only(path: &Path) -> io::Result<bool> {
        super::is_owner_only_platform(&Unlaned, path)
    }

    /// [`super::sync_dir`].
    pub fn sync_dir(dir: &Path) -> io::Result<()> {
        super::open_dir(&Unlaned, dir)?.sync_all(&Unlaned)
    }
}

/// Creates `path` and every missing ancestor with the process defaults (Node's
/// `mkdirSync(path, { recursive: true })`: the umask on Unix, the parent's ACL on Windows).
pub fn create_dir_all<L: WriteLane>(lane: &InLane<L>, path: &Path) -> io::Result<()> {
    mixdog_fsio::create_dir_all(lane, path)
}

/// Creates `path` alone, failing with `AlreadyExists` when anything is there already (Node's
/// `mkdirSync(path)` without `recursive`, which throws `EEXIST`): the claim of a name no one else holds.
pub fn create_dir<L: WriteLane>(lane: &InLane<L>, path: &Path) -> io::Result<()> {
    mixdog_fsio::create_dir(lane, path)
}

/// Creates `path` and every missing ancestor as a private directory: Unix mode 0700 (Node's
/// `mkdirSync(path, { recursive: true, mode: 0o700 })`, subject to the umask); Windows a
/// protected DACL with one full-access entry for the current user, inherited by what the
/// directory holds. A directory that exists is left as it is.
pub fn create_private_dir_all<L: WriteLane>(lane: &InLane<L>, path: &Path) -> io::Result<()> {
    if mixdog_fsio::is_dir(lane, path) {
        return Ok(());
    }
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        create_private_dir(lane, parent)?;
    }
    create_private_dir(lane, path)
}

fn create_private_dir<P: WriteProof>(proof: &P, path: &Path) -> io::Result<()> {
    if mixdog_fsio::is_dir(proof, path) {
        return Ok(());
    }
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        create_private_dir(proof, parent)?;
    }
    match create_dir_platform(proof, path) {
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists && mixdog_fsio::is_dir(proof, path) => Ok(()),
        other => other,
    }
}

#[cfg(unix)]
fn create_dir_platform<P: WriteProof>(proof: &P, path: &Path) -> io::Result<()> {
    mixdog_fsio::DirBuilder::new().mode(0o700).create(proof, path)
}

#[cfg(windows)]
fn create_dir_platform<P: WriteProof>(_proof: &P, path: &Path) -> io::Result<()> {
    owner_only::create_dir(path)
}

#[cfg(unix)]
pub(crate) fn create_new_platform<P: WriteProof>(proof: &P, path: &Path, access: Access, unix_mode: u32) -> io::Result<File> {
    let mode = if access == Access::OwnerOnly { 0o600 } else { unix_mode };
    OpenOptions::new().write(true).create_new(true).mode(mode).open(proof, path)
}

#[cfg(windows)]
pub(crate) fn create_new_platform<P: WriteProof>(proof: &P, path: &Path, access: Access, _unix_mode: u32) -> io::Result<File> {
    match access {
        Access::OwnerOnly => owner_only::create_new(path),
        Access::Inherit => OpenOptions::new().write(true).create_new(true).open(proof, path),
    }
}

/// Whether only the current user can open `path`: Unix no group/other mode bits; Windows
/// exactly the protected owner-only DACL `create_new` sets.
pub fn is_owner_only<L: IoLane>(lane: &InLane<L>, path: &Path) -> io::Result<bool> {
    is_owner_only_platform(lane, path)
}

#[cfg(unix)]
fn is_owner_only_platform<P: ReadProof>(proof: &P, path: &Path) -> io::Result<bool> {
    use std::os::unix::fs::PermissionsExt;
    Ok(mixdog_fsio::metadata(proof, path)?.permissions().mode() & 0o077 == 0)
}

#[cfg(windows)]
fn is_owner_only_platform<P: ReadProof>(_proof: &P, path: &Path) -> io::Result<bool> {
    owner_only::is_owner_only(path)
}

/// `fsync` / `FlushFileBuffers` of a directory's entries. Windows needs a write handle opened
/// with `FILE_FLAG_BACKUP_SEMANTICS`; a read-only directory handle is refused.
pub fn sync_dir<L: WriteLane>(lane: &InLane<L>, dir: &Path) -> io::Result<()> {
    open_dir(lane, dir)?.sync_all(lane)
}

#[cfg(windows)]
fn open_dir<P: WriteProof>(proof: &P, dir: &Path) -> io::Result<File> {
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
    OpenOptions::new().read(true).write(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(proof, dir)
}

#[cfg(not(windows))]
fn open_dir<P: WriteProof>(proof: &P, dir: &Path) -> io::Result<File> {
    File::open(proof, dir)
}

/// `path` as a NUL-terminated verbatim Win32 path (`\\?\C:\…`, `\\?\UNC\server\…`), the form
/// `std` passes for absolute paths: no `MAX_PATH` limit. `GetFullPathNameW` first makes it
/// absolute and normalizes `/`, `.` and `..`, which a verbatim path skips.
#[cfg(windows)]
pub fn verbatim_wide(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetFullPathNameW;
    let input: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut full = vec![0u16; input.len() + 64];
    loop {
        // SAFETY: `input` is NUL-terminated; `full` holds `full.len()` units.
        let n = unsafe { GetFullPathNameW(input.as_ptr(), full.len() as u32, full.as_mut_ptr(), std::ptr::null_mut()) }
            as usize;
        if n == 0 {
            return Err(io::Error::last_os_error());
        }
        if n < full.len() {
            full.truncate(n);
            break;
        }
        full.resize(n, 0);
    }
    let w = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
    let mut out = if full.starts_with(&w(r"\\?\")) || full.starts_with(&w(r"\\.\")) {
        full
    } else if full.starts_with(&w(r"\\")) {
        let mut v = w(r"\\?\UNC\");
        v.extend_from_slice(&full[2..]);
        v
    } else {
        let mut v = w(r"\\?\");
        v.extend_from_slice(&full);
        v
    };
    out.push(0);
    Ok(out)
}

#[cfg(windows)]
mod owner_only {
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::path::Path;
    use std::ptr::null_mut;

    use mixdog_fsio::File;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::GENERIC_READ;
    use windows_sys::Win32::Foundation::GENERIC_WRITE;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertSecurityDescriptorToStringSecurityDescriptorW;
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW;
    use windows_sys::Win32::Security::Authorization::SDDL_REVISION_1;
    use windows_sys::Win32::Security::Authorization::SE_FILE_OBJECT;
    use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
    use windows_sys::Win32::Security::GetTokenInformation;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Security::TOKEN_QUERY;
    use windows_sys::Win32::Security::TOKEN_USER;
    use windows_sys::Win32::Security::TokenUser;
    use windows_sys::Win32::Storage::FileSystem::CREATE_NEW;
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
    use windows_sys::Win32::Storage::FileSystem::CreateFileW;
    use windows_sys::Win32::Storage::FileSystem::DELETE;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_DELETE;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    use windows_sys::Win32::System::Threading::OpenProcessToken;

    fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
        text.encode_wide().chain(Some(0)).collect()
    }

    /// Text of a NUL-terminated wide string allocated by the system, which is freed.
    ///
    /// # Safety
    /// `pointer` is a valid `LocalAlloc`ed NUL-terminated UTF-16 string.
    unsafe fn take_wide(pointer: *mut u16) -> String {
        let mut len = 0;
        // SAFETY: the string is NUL-terminated per the contract.
        while unsafe { *pointer.add(len) } != 0 {
            len += 1;
        }
        // SAFETY: `len` units were just read.
        let text = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(pointer, len) });
        // SAFETY: allocated by the system with LocalAlloc.
        unsafe { LocalFree(pointer.cast()) };
        text
    }

    fn user_sid() -> io::Result<String> {
        let mut token: HANDLE = null_mut();
        // SAFETY: plain out-parameter call on the current process.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            let mut needed = 0u32;
            // SAFETY: a size query with a null buffer.
            unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut needed) };
            let mut buffer = vec![0u8; needed as usize];
            // SAFETY: `buffer` holds `needed` bytes.
            if unsafe { GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), needed, &mut needed) } == 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: the buffer holds a TOKEN_USER; a byte buffer is not aligned for it.
            let user: TOKEN_USER = unsafe { std::ptr::read_unaligned(buffer.as_ptr().cast()) };
            let mut text: *mut u16 = null_mut();
            // SAFETY: `user.User.Sid` points into `buffer`.
            if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: `text` was just allocated by the call above.
            Ok(unsafe { take_wide(text) })
        })();
        // SAFETY: `token` was opened above.
        unsafe { CloseHandle(token) };
        result
    }

    /// Protected, one entry: full access for the current user; for a directory the entry is
    /// inherited by the files and directories created in it.
    fn owner_only_sddl(directory: bool) -> io::Result<String> {
        let inherit = if directory { "OICI" } else { "" };
        Ok(format!("D:P(A;{inherit};FA;;;{})", user_sid()?))
    }

    /// Creates the directory `path` (its parent exists) with the owner-only DACL.
    pub fn create_dir(path: &Path) -> io::Result<()> {
        let sddl = wide(std::ffi::OsStr::new(&owner_only_sddl(true)?));
        let mut descriptor = null_mut();
        // SAFETY: `sddl` is NUL-terminated; the descriptor is freed below.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut())
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let name = super::verbatim_wide(path)?;
        // SAFETY: `name` is NUL-terminated and `attributes` outlives the call.
        let created = unsafe { CreateDirectoryW(name.as_ptr(), &attributes) };
        let error = io::Error::last_os_error();
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe { LocalFree(descriptor) };
        if created == 0 { Err(error) } else { Ok(()) }
    }

    pub fn create_new(path: &Path) -> io::Result<File> {
        let sddl = wide(std::ffi::OsStr::new(&owner_only_sddl(false)?));
        let mut descriptor = null_mut();
        // SAFETY: `sddl` is NUL-terminated; the descriptor is freed below.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut())
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let name = super::verbatim_wide(path)?;
        // SAFETY: `name` is NUL-terminated and `attributes` outlives the call. The sharing
        // mode matches std's, so readers and renames are not blocked.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE | DELETE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                &attributes,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        };
        let error = io::Error::last_os_error();
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe { LocalFree(descriptor) };
        if handle == INVALID_HANDLE_VALUE {
            return Err(error);
        }
        // SAFETY: a valid, owned file handle.
        Ok(unsafe { File::from_raw_handle(handle) })
    }

    pub fn is_owner_only(path: &Path) -> io::Result<bool> {
        let name = super::verbatim_wide(path)?;
        let mut descriptor = null_mut();
        // SAFETY: `name` is NUL-terminated; the descriptor is freed below.
        let status = unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let mut text: *mut u16 = null_mut();
        // SAFETY: `descriptor` was just returned by the call above.
        let converted = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                null_mut(),
            )
        };
        let error = io::Error::last_os_error();
        // SAFETY: allocated by GetNamedSecurityInfoW.
        unsafe { LocalFree(descriptor) };
        if converted == 0 {
            return Err(error);
        }
        // SAFETY: allocated by the conversion above.
        let actual = unsafe { take_wide(text) };
        Ok(actual == owner_only_sddl(false)? || actual == owner_only_sddl(true)?)
    }
}
