//! The host the codex `User-Agent` describes (`providers/codex-client-meta.mjs` `_osType`,
//! `_arch`): Node's `os.type()`, `os.release()` and `os.arch()` in codex's vocabulary. The raw
//! values are libuv's: `uname` on Unix, and on Windows `Windows_NT` with the `major.minor.build`
//! of `RtlGetVersion`.

use super::process::HostInfo;

/// `os.arch()`: Node's name for the architecture this binary runs on.
#[cfg(target_arch = "x86_64")]
const NODE_ARCH: &str = "x64";
#[cfg(target_arch = "aarch64")]
const NODE_ARCH: &str = "arm64";
#[cfg(target_arch = "x86")]
const NODE_ARCH: &str = "ia32";
#[cfg(target_arch = "arm")]
const NODE_ARCH: &str = "arm";

impl HostInfo {
    /// `_osType()` and `_arch()` over Node's `os.type()` / `os.arch()`; the release is
    /// `os.release()` as it is.
    pub fn from_node(os_type: &str, release: &str, arch: &str) -> Self {
        let os_type = match os_type {
            "Windows_NT" => "Windows",
            "Darwin" => "Mac OS",
            other => other,
        };
        let arch = match arch {
            "x64" => "x86_64",
            "arm64" => "aarch64",
            other => other,
        };
        Self { os_type: os_type.to_owned(), os_release: release.to_owned(), arch: arch.to_owned() }
    }

    /// The machine this process runs on.
    pub fn current() -> std::io::Result<Self> {
        let (os_type, release) = uname()?;
        Ok(Self::from_node(&os_type, &release, NODE_ARCH))
    }
}

/// libuv's `uv_os_uname`: `(sysname, release)`.
#[cfg(unix)]
fn uname() -> std::io::Result<(String, String)> {
    // SAFETY: `utsname` is plain bytes, valid all-zero.
    let mut info: libc::utsname = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a valid out-pointer for the call.
    if unsafe { libc::uname(&mut info) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let text = |field: &[libc::c_char]| {
        // SAFETY: `uname` fills each field with a NUL-terminated string.
        unsafe { std::ffi::CStr::from_ptr(field.as_ptr()) }.to_string_lossy().into_owned()
    };
    Ok((text(&info.sysname), text(&info.release)))
}

/// libuv's `uv_os_uname` on Windows: `Windows_NT` and `<major>.<minor>.<build>`.
#[cfg(windows)]
fn uname() -> std::io::Result<(String, String)> {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    // SAFETY: `OSVERSIONINFOW` is plain integers and an array, valid all-zero.
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    // SAFETY: `info` is a valid out-pointer with its size field set.
    let status = unsafe { RtlGetVersion(&mut info) };
    if status != 0 {
        return Err(std::io::Error::other(format!("RtlGetVersion failed: NTSTATUS {status:#x}")));
    }
    Ok(("Windows_NT".to_owned(), format!("{}.{}.{}", info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber)))
}
