//! The production [`PcAccessInstaller`]: the one secure-desktop installer of `mixdog-tools`
//! (`PcAccessHelper`, the bundled bridge run as a child process) behind the trait the `pcAccess` domain drives.
//! Off Windows there is no helper: every state reads `unavailable` and an install or enroll answers `unavailable`
//! (the readiness row reports PC access unsupported there, as the desktop's `windowsPcAccess() === null` did).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

use super::pc_access::HelperState;
use super::pc_access::KeyChange;
use super::pc_access::PcAccessInstaller;

/// The installer over the bridge executable at `exe` (`native-tools/mixdog-secure-desktop.exe` of the package,
/// else the crate's `target/release` in development). Made inside the runtime; one per core, so its single
/// in-flight latch covers every caller.
#[cfg(windows)]
pub fn production_installer(exe: PathBuf) -> Arc<dyn PcAccessInstaller> {
    Arc::new(windows::BridgeInstaller { helper: mixdog_tools::desktop::pc_access_helper::PcAccessHelper::new(exe) })
}

#[cfg(not(windows))]
pub fn production_installer(_exe: PathBuf) -> Arc<dyn PcAccessInstaller> {
    Arc::new(Unavailable)
}

#[cfg(not(windows))]
struct Unavailable;

#[cfg(not(windows))]
#[async_trait]
impl PcAccessInstaller for Unavailable {
    async fn state(&self, _key: Option<&str>) -> HelperState {
        HelperState::Unavailable
    }

    async fn install(&self, _keys: &[String], _revoke: &[String]) -> KeyChange {
        KeyChange { outcome: super::pc_access::KeyOutcome::Unavailable, detail: None, exit_code: None }
    }

    async fn enroll(&self, _keys: &[String], _revoke: &[String]) -> KeyChange {
        KeyChange { outcome: super::pc_access::KeyOutcome::Unavailable, detail: None, exit_code: None }
    }
}

#[cfg(windows)]
mod windows {
    use mixdog_tools::desktop::pc_access_helper::InstallState;
    use mixdog_tools::desktop::pc_access_helper::KeyChangeOptions;
    use mixdog_tools::desktop::pc_access_helper::KeyChangeOutcome;
    use mixdog_tools::desktop::pc_access_helper::KeyChangeResult;
    use mixdog_tools::desktop::pc_access_helper::PcAccessHelper;

    use super::super::pc_access::KeyOutcome;
    use super::*;

    pub(super) struct BridgeInstaller {
        pub(super) helper: PcAccessHelper,
    }

    pub(super) fn helper_state(state: InstallState) -> HelperState {
        match state {
            InstallState::Installed => HelperState::Installed,
            InstallState::Outdated => HelperState::Outdated,
            InstallState::NotInstalled => HelperState::NotInstalled,
            InstallState::NotEnrolled => HelperState::NotEnrolled,
            InstallState::OtherUser => HelperState::OtherUser,
            InstallState::Unavailable => HelperState::Unavailable,
        }
    }

    /// The installer's outcome as the domain names it; the ones the UAC path does not produce (a revoke, the
    /// batch-logon and delegated refusals) keep their kebab-case name, which the domain reads as failed.
    pub(super) fn key_outcome(outcome: KeyChangeOutcome) -> KeyOutcome {
        match outcome {
            KeyChangeOutcome::Installed => KeyOutcome::Installed,
            KeyChangeOutcome::Updated => KeyOutcome::Updated,
            KeyChangeOutcome::Enrolled => KeyOutcome::Enrolled,
            KeyChangeOutcome::Declined => KeyOutcome::Declined,
            KeyChangeOutcome::Failed => KeyOutcome::Failed,
            KeyChangeOutcome::InProgress => KeyOutcome::InProgress,
            KeyChangeOutcome::OtherUser => KeyOutcome::OtherUser,
            KeyChangeOutcome::Unavailable => KeyOutcome::Unavailable,
            other => KeyOutcome::Other(match serde_json::to_value(other) {
                Ok(serde_json::Value::String(name)) => name,
                _ => format!("{other:?}"),
            }),
        }
    }

    pub(super) fn key_change(result: KeyChangeResult) -> KeyChange {
        KeyChange { outcome: key_outcome(result.outcome), detail: result.detail, exit_code: result.exit_code }
    }

    #[async_trait]
    impl PcAccessInstaller for BridgeInstaller {
        async fn state(&self, key: Option<&str>) -> HelperState {
            helper_state(self.helper.state(key.map(str::to_string)).await)
        }

        async fn install(&self, keys: &[String], revoke: &[String]) -> KeyChange {
            key_change(self.helper.install(keys.to_vec(), KeyChangeOptions { revoke: revoke.to_vec(), ..KeyChangeOptions::default() }).await)
        }

        async fn enroll(&self, keys: &[String], revoke: &[String]) -> KeyChange {
            key_change(self.helper.enroll(keys.to_vec(), KeyChangeOptions { revoke: revoke.to_vec(), ..KeyChangeOptions::default() }).await)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn every_install_state_maps_to_its_helper_state() {
            assert_eq!(helper_state(InstallState::Installed), HelperState::Installed);
            assert_eq!(helper_state(InstallState::Outdated), HelperState::Outdated);
            assert_eq!(helper_state(InstallState::NotInstalled), HelperState::NotInstalled);
            assert_eq!(helper_state(InstallState::NotEnrolled), HelperState::NotEnrolled);
            assert_eq!(helper_state(InstallState::OtherUser), HelperState::OtherUser);
            assert_eq!(helper_state(InstallState::Unavailable), HelperState::Unavailable);
        }

        #[test]
        fn the_outcomes_of_the_uac_path_keep_their_meaning_and_the_rest_keep_their_name() {
            assert_eq!(key_outcome(KeyChangeOutcome::Installed), KeyOutcome::Installed);
            assert_eq!(key_outcome(KeyChangeOutcome::Updated), KeyOutcome::Updated);
            assert_eq!(key_outcome(KeyChangeOutcome::Enrolled), KeyOutcome::Enrolled);
            assert_eq!(key_outcome(KeyChangeOutcome::Declined), KeyOutcome::Declined);
            assert_eq!(key_outcome(KeyChangeOutcome::Failed), KeyOutcome::Failed);
            assert_eq!(key_outcome(KeyChangeOutcome::InProgress), KeyOutcome::InProgress);
            assert_eq!(key_outcome(KeyChangeOutcome::OtherUser), KeyOutcome::OtherUser);
            assert_eq!(key_outcome(KeyChangeOutcome::Unavailable), KeyOutcome::Unavailable);
            assert_eq!(key_outcome(KeyChangeOutcome::Revoked), KeyOutcome::Other("revoked".to_string()));
            assert_eq!(key_outcome(KeyChangeOutcome::DelegationDenied), KeyOutcome::Other("delegation-denied".to_string()));
            assert_eq!(key_outcome(KeyChangeOutcome::ServiceUnreachable), KeyOutcome::Other("service-unreachable".to_string()));
        }

        #[test]
        fn a_result_carries_its_detail_and_exit_code() {
            let change = key_change(KeyChangeResult { outcome: KeyChangeOutcome::Failed, state: InstallState::NotInstalled, detail: Some("why".to_string()), exit_code: Some(5) });
            assert_eq!(change, KeyChange { outcome: KeyOutcome::Failed, detail: Some("why".to_string()), exit_code: Some(5) });
        }
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::super::pc_access::KeyOutcome;
    use super::*;

    #[tokio::test]
    async fn off_windows_the_helper_is_unavailable_and_nothing_installs() {
        let installer = production_installer(PathBuf::from("none"));
        assert_eq!(installer.state(None).await, HelperState::Unavailable);
        assert_eq!(installer.install(&[], &[]).await.outcome, KeyOutcome::Unavailable);
        assert_eq!(installer.enroll(&[], &[]).await.outcome, KeyOutcome::Unavailable);
    }
}
