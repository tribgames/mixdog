//! `server-ensure` failures. The codes are the contract with the desktop's SSH guidance; the
//! ones that existed in the 1.4.5 installer keep their names.

use super::host::DrainReport;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnsureError {
    InstallLocked {
        lock: String,
        owner: String,
    },
    InstallFailed(String),
    InstallMissing(String),
    ChecksumMismatch {
        expected: String,
        actual: String,
    },
    UnsafeInstallId(String),
    BadVersion(String),
    CoreExited {
        status: String,
        log: String,
        tail: String,
    },
    /// 1.4.5's `daemon-timeout`: the launched core stayed in `state` past the ready bound.
    CoreNotReady {
        seconds: u64,
        state: String,
        log: String,
        tail: String,
    },
    /// The ssh session that runs this program closed while it waited for the core.
    ControllerGone,
    Core(String),
    DaemonUnproven(String),
    /// Node's `terminateProcess` failure: the core outlived SIGKILL.
    DaemonStop(u32),
    ClientOutdated {
        desktop_version: String,
        server_version: String,
    },
    /// The older core is still running work; the desktop shows the list and may confirm.
    Busy {
        server_version: String,
        drain: DrainReport,
    },
    Arguments(String),
}

impl std::fmt::Display for EnsureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.said().english)
    }
}

impl std::error::Error for EnsureError {}

impl EnsureError {
    /// What this says, by code and with its parameters: the desktop words it in the user's language from the `MIXDOG_NOTICE` line,
    /// and the English is what the `MIXDOG_ERROR` line carries (older desktops, logs).
    pub fn said(&self) -> mixdog_app_protocol::message::Said {
        use mixdog_app_protocol::message::server as text;
        match self {
            EnsureError::InstallLocked { lock, owner } => text::ENSURE_INSTALL_LOCKED.said([("lock", lock), ("owner", owner)]),
            EnsureError::InstallFailed(detail) => text::ENSURE_INSTALL_FAILED.said([("detail", detail)]),
            EnsureError::InstallMissing(install) => text::ENSURE_INSTALL_MISSING.said([("install", install)]),
            EnsureError::ChecksumMismatch { expected, actual } => text::ENSURE_CHECKSUM.said([("expected", expected), ("actual", actual)]),
            EnsureError::UnsafeInstallId(id) => text::ENSURE_UNSAFE_ID.said([("id", id)]),
            EnsureError::BadVersion(version) => text::ENSURE_BAD_VERSION.said([("version", version)]),
            EnsureError::CoreExited { status, log, tail } => text::ENSURE_CORE_EXITED.said([("status", status), ("log", log), ("tail", tail)]),
            EnsureError::CoreNotReady { seconds, state, log, tail } => {
                text::ENSURE_CORE_NOT_READY.said([("seconds", seconds.to_string()), ("state", state.clone()), ("log", log.clone()), ("tail", tail.clone())])
            }
            EnsureError::ControllerGone => text::ENSURE_CONTROLLER_GONE.plain(),
            EnsureError::Core(detail) => text::ENSURE_CORE_CONTROL.said([("detail", detail)]),
            EnsureError::DaemonUnproven(detail) => text::ENSURE_UNPROVEN.said([("detail", detail)]),
            EnsureError::DaemonStop(pid) => text::ENSURE_STOP_FAILED.said([("pid", pid)]),
            EnsureError::ClientOutdated { desktop_version, server_version } => {
                text::ENSURE_CLIENT_OUTDATED.said([("desktop_version", desktop_version), ("server_version", server_version)])
            }
            EnsureError::Busy { server_version, .. } => text::ENSURE_BUSY.said([("server_version", server_version)]),
            EnsureError::Arguments(detail) => text::ENSURE_ARGUMENTS.said([("detail", detail)]),
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            EnsureError::InstallLocked { .. } => "install-locked",
            EnsureError::InstallFailed(_) => "install-failed",
            EnsureError::InstallMissing(_) => "install-missing",
            EnsureError::ChecksumMismatch { .. } => "checksum-mismatch",
            EnsureError::UnsafeInstallId(_) => "install-failed",
            EnsureError::BadVersion(_) => "protocol",
            EnsureError::CoreExited { .. } => "core-exited",
            EnsureError::CoreNotReady { .. } => "daemon-timeout",
            EnsureError::ControllerGone => "controller-gone",
            EnsureError::Core(_) => "core-control",
            EnsureError::DaemonUnproven(_) => "daemon-unproven",
            EnsureError::DaemonStop(_) => "daemon-stop",
            EnsureError::ClientOutdated { .. } => "client-outdated",
            EnsureError::Busy { .. } => "daemon-busy-other-version",
            EnsureError::Arguments(_) => "protocol",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_variant() -> Vec<EnsureError> {
        let drain = DrainReport { drain_id: "d".into(), running: Vec::new(), confirm_token: "t".into() };
        vec![
            EnsureError::InstallLocked { lock: "l".into(), owner: "o".into() },
            EnsureError::InstallFailed("d".into()),
            EnsureError::InstallMissing("i".into()),
            EnsureError::ChecksumMismatch { expected: "e".into(), actual: "a".into() },
            EnsureError::UnsafeInstallId("i".into()),
            EnsureError::BadVersion("v".into()),
            EnsureError::CoreExited { status: "1".into(), log: "l".into(), tail: "t".into() },
            EnsureError::CoreNotReady { seconds: 4, state: "s".into(), log: "l".into(), tail: "t".into() },
            EnsureError::ControllerGone,
            EnsureError::Core("d".into()),
            EnsureError::DaemonUnproven("d".into()),
            EnsureError::DaemonStop(7),
            EnsureError::ClientOutdated { desktop_version: "1".into(), server_version: "2".into() },
            EnsureError::Busy { server_version: "2".into(), drain },
            EnsureError::Arguments("d".into()),
        ]
    }

    /// Every variant says something by code, the codes are exactly the server list the generator exports, and every slot of the
    /// English is filled by a parameter the variant sends.
    #[test]
    fn every_error_has_a_code_in_the_exported_list_and_fills_its_slots() {
        let mut said_codes: Vec<&str> = Vec::new();
        let errors = every_variant();
        let saids: Vec<_> = errors.iter().map(EnsureError::said).collect();
        for said in &saids {
            assert!(!said.english.contains('{'), "an unfilled slot: {}", said.english);
            assert!(mixdog_app_protocol::message::server::ALL.iter().any(|text| text.code == said.message.code), "{}", said.message.code);
            said_codes.push(said.message.code.as_str());
        }
        said_codes.sort_unstable();
        let mut listed: Vec<&str> = mixdog_app_protocol::message::server::ALL.iter().map(|text| text.code).collect();
        listed.sort_unstable();
        assert_eq!(said_codes, listed, "a sentence is listed that no error says, or the other way round");
        for error in &errors {
            assert!(!error.code().is_empty());
        }
    }
}
