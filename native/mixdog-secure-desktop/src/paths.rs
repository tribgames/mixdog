//! Well-known names and filesystem locations. Kept free of Windows API calls so
//! the layout is testable and documented in one place.

use std::path::PathBuf;

/// The Windows service name registered with the SCM.
pub const SERVICE_NAME: &str = "MixdogSecureDesktop";

/// The service display name shown in services.msc.
pub const SERVICE_DISPLAY_NAME: &str = "Mixdog Secure Desktop Bridge";

/// Fixed app-facing pipe name. A fixed name is safe here: the pipe's DACL
/// admits only the installing user and SYSTEM, and the hello handshake requires
/// the per-install secret. The leading component after `pipe\` is unique enough
/// to avoid collisions with other products.
pub const PIPE_NAME: &str = r"\\.\pipe\mixdog-secure-desktop";

/// Kernel-object names of one helper's shutdown channel, from its per-launch
/// token: `(stop, ack)`. The service signals `stop`; the helper signals `ack`
/// after it has released all held input, just before it exits. `Global\` so the
/// session-0 service and the console-session helper name the same objects.
pub fn shutdown_event_names(token: &str) -> (String, String) {
    (
        format!(r"Global\MixdogSecureDesktop-stop-{token}"),
        format!(r"Global\MixdogSecureDesktop-ack-{token}"),
    )
}

/// Schema version of the on-disk install state. Independent of the wire
/// protocol version.
pub const STATE_SCHEMA_VERSION: u32 = 1;

/// `%ProgramData%` — the machine-wide application-data root. It exists on every
/// Windows install and is the already-present base below which the protected
/// Mixdog directories are created; it is itself never created or
/// re-permissioned by the installer.
pub fn program_data_root() -> PathBuf {
    std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
}

/// `%ProgramData%\Mixdog\SecureDesktop`. ProgramData is machine-wide and
/// readable by all users by default, so everything written here is given an
/// explicit DACL rather than relying on inheritance. The intermediate
/// `%ProgramData%\Mixdog` may not exist yet, so the installer creates the whole
/// chain below `%ProgramData%` top-down with that protected DACL.
pub fn state_dir() -> PathBuf {
    program_data_root().join("Mixdog").join("SecureDesktop")
}

/// The ACL-protected install state (secret, installing user SID, versions).
pub fn state_file() -> PathBuf {
    state_dir().join("state.json")
}

/// Directory holding the copy of the service binary the SCM runs. It lives
/// under the protected state directory so it inherits the same admin/SYSTEM-only
/// DACL; the installer never registers the user-writable source path.
pub fn bin_dir() -> PathBuf {
    state_dir().join("bin")
}

/// The protected copy of the service executable that the service is registered
/// against. Installed by copying the current executable here under an explicit
/// admin/SYSTEM-only DACL, then verified before registration.
pub fn bin_exe() -> PathBuf {
    bin_dir().join("mixdog-secure-desktop.exe")
}

/// Append-only operational log (install/uninstall/start/stop/desktop changes).
pub fn log_file() -> PathBuf {
    state_dir().join("secure-desktop.log")
}
