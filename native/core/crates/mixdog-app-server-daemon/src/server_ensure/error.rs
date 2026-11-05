//! `server-ensure` failures. The codes are the contract with the desktop's SSH guidance; the
//! ones that existed in the 1.4.5 installer keep their names.

use super::host::DrainReport;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EnsureError {
    #[error("Another Mixdog install on the server holds {lock} ({owner}). Try again when it has finished.")]
    InstallLocked { lock: String, owner: String },
    #[error("{0}")]
    InstallFailed(String),
    #[error("The server install {0} is missing and must be uploaded.")]
    InstallMissing(String),
    #[error("The uploaded binary does not match its checksum (expected {expected}, got {actual}).")]
    ChecksumMismatch { expected: String, actual: String },
    #[error("Unsafe install id: {0}")]
    UnsafeInstallId(String),
    #[error("Not a version: {0}")]
    BadVersion(String),
    #[error("The Mixdog core exited on the server (status {status}). {log}: {tail}")]
    CoreExited { status: String, log: String, tail: String },
    #[error("Managing the core on the server failed: {0}")]
    Core(String),
    #[error("{0}")]
    DaemonUnproven(String),
    #[error("This Mixdog (version {desktop_version}) is older than the Mixdog on the server (version {server_version}). Update Mixdog on this computer.")]
    ClientOutdated { desktop_version: String, server_version: String },
    /// The older core is still running work; the desktop shows the list and may confirm.
    #[error("The Mixdog on the server (version {server_version}) is still running work. Wait for it to finish, or stop it.")]
    Busy { server_version: String, drain: DrainReport },
    #[error("The server program was not given usable arguments: {0}")]
    Arguments(String),
}

impl EnsureError {
    pub fn code(&self) -> &'static str {
        match self {
            EnsureError::InstallLocked { .. } => "install-locked",
            EnsureError::InstallFailed(_) => "install-failed",
            EnsureError::InstallMissing(_) => "install-missing",
            EnsureError::ChecksumMismatch { .. } => "checksum-mismatch",
            EnsureError::UnsafeInstallId(_) => "install-failed",
            EnsureError::BadVersion(_) => "protocol",
            EnsureError::CoreExited { .. } => "core-exited",
            EnsureError::Core(_) => "core-control",
            EnsureError::DaemonUnproven(_) => "daemon-unproven",
            EnsureError::ClientOutdated { .. } => "client-outdated",
            EnsureError::Busy { .. } => "daemon-busy-other-version",
            EnsureError::Arguments(_) => "protocol",
        }
    }
}
