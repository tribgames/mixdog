//! Discovery: one file, `<runtime root>/daemon.json` (LR §4).
//!
//! The runtime root is the one 1.4.5 clients resolve, and the shape is a
//! superset 1.4.5 readers parse: they use only `pid` and `endpoints.session`,
//! which name the control listener (whose legacy surface tells them to update).
//! The file is owner-only and replaced atomically. It is removed at release
//! only when it names this core's instance.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "blocking file bodies: publish/withdraw/read are synchronous and run at core startup and release, never on an async worker"
)]

#[cfg(test)]
mod tests;

use std::ffi::OsString;
use std::io;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use serde::Serialize;

pub const DISCOVERY_FILE: &str = "daemon.json";

/// Node's `os.tmpdir()`, which 1.4.5 roots the runtime directory in.
fn node_tmpdir() -> PathBuf {
    let var = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());
    #[cfg(windows)]
    {
        let path: OsString = var("TEMP").or_else(|| var("TMP")).unwrap_or_else(|| {
            let mut root = var("SystemRoot")
                .or_else(|| var("windir"))
                .unwrap_or_default();
            root.push("\\temp");
            root
        });
        let text = path.to_string_lossy();
        if text.len() > 1 && text.ends_with('\\') && !text.ends_with(":\\") {
            return PathBuf::from(&text[..text.len() - 1]);
        }
        PathBuf::from(path)
    }
    #[cfg(unix)]
    {
        let path: OsString = var("TMPDIR")
            .or_else(|| var("TMP"))
            .or_else(|| var("TEMP"))
            .unwrap_or_else(|| "/tmp".into());
        let text = path.to_string_lossy();
        if text.len() > 1 && text.ends_with('/') {
            return PathBuf::from(&text[..text.len() - 1]);
        }
        PathBuf::from(path)
    }
}

/// The runtime root 1.4.5 clients resolve (`T:src/runtime/shared/runtime-root.mjs:32-47`):
/// `MIXDOG_RUNTIME_ROOT`, else `tmpdir()/mixdog` on Windows, else `tmpdir()/mixdog-<uid>`.
pub fn runtime_root() -> io::Result<PathBuf> {
    if let Some(configured) = std::env::var_os("MIXDOG_RUNTIME_ROOT") {
        let text = configured.to_string_lossy();
        if !text.trim().is_empty() {
            return std::path::absolute(text.trim());
        }
    }
    #[cfg(windows)]
    let name = String::from("mixdog");
    #[cfg(unix)]
    // SAFETY: getuid has no preconditions.
    let name = format!("mixdog-{}", unsafe { libc::getuid() });
    Ok(node_tmpdir().join(name))
}

/// Creates the runtime root owner-only (Unix: mode 0700, refused when another
/// user owns it), as 1.4.5's `ensurePrivateRuntimeRoot` does.
pub fn ensure_private_root(root: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(root)?;
        let meta = std::fs::symlink_metadata(root)?;
        // SAFETY: getuid has no preconditions.
        if !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "runtime root is not owned by the current user: {}",
                    root.display()
                ),
            ));
        }
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(windows)]
    {
        std::fs::create_dir_all(root)
    }
}

pub fn path(root: &Path) -> PathBuf {
    root.join(DISCOVERY_FILE)
}

/// The one token: it authenticates the RPC upgrade and every management request.
pub fn generate_token() -> String {
    format!(
        "{:032x}{:032x}",
        rand::random::<u128>(),
        rand::random::<u128>()
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CoreState {
    Booting,
    Blocked,
    Migrating,
    Serving,
    Draining,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Port {
    pub port: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SessionEndpoint {
    pub port: u16,
    pub token: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Endpoints {
    pub session: SessionEndpoint,
    /// Present exactly when the core runs models through the desktop's model proxy; absent
    /// when it uses the server's own logins. The 1.4.5 file carries it the same way, and
    /// server-ensure reads the model-login mode from it.
    #[serde(rename = "modelProxy", skip_serializing_if = "Option::is_none")]
    pub model_proxy: Option<SessionEndpoint>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreSection {
    pub version: String,
    pub build: String,
    pub instance_id: String,
    pub process_start_time: String,
    pub state: CoreState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drain: Option<serde_json::Value>,
    /// Present only while `serving`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rpc: Option<Port>,
    /// Present while the process lives.
    pub control: Port,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Discovery {
    pub pid: u32,
    /// `session` names the control listener, as 1.4.5 readers expect.
    pub endpoints: Endpoints,
    pub core: CoreSection,
}

/// Whether discovery bytes name core instance `instance_id`.
pub fn names_instance(bytes: &[u8], instance_id: &str) -> bool {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .is_some_and(|value| {
            value
                .get("core")
                .and_then(|core| core.get("instanceId"))
                .and_then(serde_json::Value::as_str)
                == Some(instance_id)
        })
}

/// Publishes `discovery` at `<root>/daemon.json`: written owner-only to a
/// staging file, synced, and renamed over the old file.
pub fn publish(root: &Path, discovery: &Discovery) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(discovery).map_err(io::Error::other)?;
    bytes.push(b'\n');
    let staging = root.join(format!(
        "{DISCOVERY_FILE}.{}.tmp",
        discovery.core.instance_id
    ));
    let target = path(root);
    let written = (|| {
        let mut file = sys::create_owner_only(&staging)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        sys::replace(&staging, &target)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    written
}

/// Removes the discovery file when it names `instance_id` (LR §5.3 step 5).
/// No other core can publish before this core's lock is released.
pub fn withdraw(root: &Path, instance_id: &str) -> io::Result<bool> {
    let target = path(root);
    match std::fs::read(&target) {
        Ok(bytes) if names_instance(&bytes, instance_id) => {
            std::fs::remove_file(&target)?;
            Ok(true)
        }
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
mod sys {
    use std::fs::File;
    use std::fs::OpenOptions;
    use std::io;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::Path;

    pub(super) fn create_owner_only(path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
    }

    pub(super) fn replace(from: &Path, to: &Path) -> io::Result<()> {
        std::fs::rename(from, to)?;
        File::open(to.parent().expect("discovery has a parent"))?.sync_all()
    }
}

#[cfg(windows)]
mod sys {
    use std::fs::File;
    use std::io;
    use std::os::windows::io::FromRawHandle;
    use std::path::Path;

    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::Authorization::SDDL_REVISION_1;
    use windows_sys::Win32::Security::GetTokenInformation;
    use windows_sys::Win32::Security::PSECURITY_DESCRIPTOR;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Security::TOKEN_QUERY;
    use windows_sys::Win32::Security::TOKEN_USER;
    use windows_sys::Win32::Security::TokenUser;
    use windows_sys::Win32::Storage::FileSystem::CREATE_NEW;
    use windows_sys::Win32::Storage::FileSystem::CreateFileW;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_WRITE;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    use windows_sys::Win32::System::Threading::OpenProcessToken;

    use crate::ownership::dir_wide;

    /// The current user's SID string.
    fn user_sid() -> io::Result<String> {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: pseudo-handle of this process and an out-pointer.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            let mut buffer = vec![0u64; 64];
            let mut needed = 0u32;
            // SAFETY: valid token; the buffer is its length in bytes, 8-byte aligned.
            let ok = unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    (buffer.len() * 8) as u32,
                    &mut needed,
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: on success the buffer starts with a TOKEN_USER.
            let sid = unsafe { (*(buffer.as_ptr() as *const TOKEN_USER)).User.Sid };
            let mut text: *mut u16 = std::ptr::null_mut();
            // SAFETY: valid SID; the string is allocated by the system.
            if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: `text` is a NUL-terminated wide string freed once below.
            let sid = unsafe {
                let len = (0..).take_while(|i| *text.add(*i) != 0).count();
                let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
                LocalFree(text.cast());
                sid
            };
            Ok(sid)
        })();
        // SAFETY: the token handle is closed once.
        unsafe { CloseHandle(token) };
        result
    }

    /// Creates `path` with a protected DACL granting only the current user.
    pub(super) fn create_owner_only(path: &Path) -> io::Result<File> {
        let sddl: Vec<u16> = format!("D:P(A;;FA;;;{})", user_sid()?)
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: NUL-terminated SDDL and an out-pointer.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let wide = dir_wide(path);
        // SAFETY: valid path, attributes and descriptor.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_GENERIC_WRITE,
                0,
                &attributes,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        let error = io::Error::last_os_error();
        // SAFETY: the descriptor was allocated by the conversion and is freed once.
        unsafe { LocalFree(descriptor) };
        if handle == INVALID_HANDLE_VALUE {
            return Err(error);
        }
        // SAFETY: a valid file handle owned from here on.
        Ok(unsafe { File::from_raw_handle(handle) })
    }

    pub(super) fn replace(from: &Path, to: &Path) -> io::Result<()> {
        use windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING;
        use windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH;
        use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
        let (from, to) = (dir_wide(from), dir_wide(to));
        // SAFETY: NUL-terminated wide paths.
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
