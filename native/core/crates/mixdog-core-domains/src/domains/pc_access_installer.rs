//! The production [`PcAccessInstaller`]: the one secure-desktop installer of `mixdog-tools`
//! (`PcAccessHelper`, the bundled bridge run as a child process) behind the trait the `pcAccess` domain drives.
//! Off Windows there is no helper: every state reads `unavailable` and an install or enroll answers `unavailable`
//! (the readiness row reports PC access unsupported there, as the desktop's `windowsPcAccess() === null` did).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

use super::pc_access::HelperState;
use super::pc_access::KeyChange;
use super::pc_access::KeyOptions;
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
fn unavailable() -> KeyChange {
    KeyChange { outcome: super::pc_access::KeyOutcome::Unavailable, detail: None, exit_code: None }
}

#[cfg(not(windows))]
#[async_trait]
impl PcAccessInstaller for Unavailable {
    async fn state(&self, _key: Option<&str>) -> HelperState {
        HelperState::Unavailable
    }

    async fn install(&self, _keys: &[String], _options: &KeyOptions) -> KeyChange {
        unavailable()
    }

    async fn enroll(&self, _keys: &[String], _options: &KeyOptions) -> KeyChange {
        unavailable()
    }

    async fn enroll_delegated(&self, _keys: &[String]) -> KeyChange {
        unavailable()
    }

    async fn revoke_delegated(&self, _key: &str) -> KeyChange {
        unavailable()
    }
}

#[cfg(windows)]
mod windows {
    use mixdog_tools::desktop::pc_access_helper::Credential;
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

    /// The installer's outcome as the domain names it.
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
            KeyChangeOutcome::Revoked => KeyOutcome::Revoked,
            KeyChangeOutcome::BadCredentials => KeyOutcome::BadCredentials,
            KeyChangeOutcome::NotAdmin => KeyOutcome::NotAdmin,
            KeyChangeOutcome::LogonTypeDenied => KeyOutcome::LogonTypeDenied,
            KeyChangeOutcome::AccountLocked => KeyOutcome::AccountLocked,
            KeyChangeOutcome::AccountDisabled => KeyOutcome::AccountDisabled,
            KeyChangeOutcome::PolicyBlocked => KeyOutcome::PolicyBlocked,
            KeyChangeOutcome::DelegationDisabled => KeyOutcome::DelegationDisabled,
            KeyChangeOutcome::DelegationDenied => KeyOutcome::DelegationDenied,
            KeyChangeOutcome::ServiceUnreachable => KeyOutcome::ServiceUnreachable,
        }
    }

    pub(super) fn key_change(result: KeyChangeResult) -> KeyChange {
        KeyChange { outcome: key_outcome(result.outcome), detail: result.detail, exit_code: result.exit_code }
    }

    fn change_options(options: &KeyOptions) -> KeyChangeOptions {
        KeyChangeOptions {
            revoke: options.revoke.clone(),
            credential: options.credential.as_ref().map(|credential| Credential { user: credential.user.clone(), password: credential.password.clone() }),
            delegated: None,
        }
    }

    fn delegated() -> KeyChangeOptions {
        KeyChangeOptions { delegated: Some(true), ..KeyChangeOptions::default() }
    }

    #[async_trait]
    impl PcAccessInstaller for BridgeInstaller {
        async fn state(&self, key: Option<&str>) -> HelperState {
            helper_state(self.helper.state(key.map(str::to_string)).await)
        }

        async fn install(&self, keys: &[String], options: &KeyOptions) -> KeyChange {
            key_change(self.helper.install(keys.to_vec(), change_options(options)).await)
        }

        async fn enroll(&self, keys: &[String], options: &KeyOptions) -> KeyChange {
            key_change(self.helper.enroll(keys.to_vec(), change_options(options)).await)
        }

        async fn enroll_delegated(&self, keys: &[String]) -> KeyChange {
            key_change(self.helper.enroll(keys.to_vec(), delegated()).await)
        }

        async fn revoke_delegated(&self, key: &str) -> KeyChange {
            key_change(self.helper.revoke(key.to_string(), delegated()).await)
        }
    }

    #[cfg(test)]
    mod tests {
        use crate::domains::pc_access::PcCredential;

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
        fn every_outcome_keeps_its_meaning_and_its_name() {
            for (outcome, expected, name) in [
                (KeyChangeOutcome::Installed, KeyOutcome::Installed, "installed"),
                (KeyChangeOutcome::Updated, KeyOutcome::Updated, "updated"),
                (KeyChangeOutcome::Enrolled, KeyOutcome::Enrolled, "enrolled"),
                (KeyChangeOutcome::Declined, KeyOutcome::Declined, "declined"),
                (KeyChangeOutcome::Failed, KeyOutcome::Failed, "failed"),
                (KeyChangeOutcome::InProgress, KeyOutcome::InProgress, "in-progress"),
                (KeyChangeOutcome::OtherUser, KeyOutcome::OtherUser, "other-user"),
                (KeyChangeOutcome::Unavailable, KeyOutcome::Unavailable, "unavailable"),
                (KeyChangeOutcome::Revoked, KeyOutcome::Revoked, "revoked"),
                (KeyChangeOutcome::BadCredentials, KeyOutcome::BadCredentials, "bad-credentials"),
                (KeyChangeOutcome::NotAdmin, KeyOutcome::NotAdmin, "not-admin"),
                (KeyChangeOutcome::LogonTypeDenied, KeyOutcome::LogonTypeDenied, "logon-type-denied"),
                (KeyChangeOutcome::AccountLocked, KeyOutcome::AccountLocked, "account-locked"),
                (KeyChangeOutcome::AccountDisabled, KeyOutcome::AccountDisabled, "account-disabled"),
                (KeyChangeOutcome::PolicyBlocked, KeyOutcome::PolicyBlocked, "policy-blocked"),
                (KeyChangeOutcome::DelegationDisabled, KeyOutcome::DelegationDisabled, "delegation-disabled"),
                (KeyChangeOutcome::DelegationDenied, KeyOutcome::DelegationDenied, "delegation-denied"),
                (KeyChangeOutcome::ServiceUnreachable, KeyOutcome::ServiceUnreachable, "service-unreachable"),
            ] {
                assert_eq!(key_outcome(outcome), expected);
                // The installer's own kebab-case name is the domain's.
                assert_eq!(serde_json::to_value(outcome).unwrap(), serde_json::Value::String(name.to_string()));
                assert_eq!(expected.name(), name);
            }
        }

        #[test]
        fn the_phones_password_rides_the_options_and_the_delegated_path_carries_none() {
            let options = KeyOptions {
                revoke: vec!["old".to_string()],
                credential: Some(PcCredential { user: Some("me".to_string()), password: "pw".to_string() }),
            };
            let mapped = change_options(&options);
            assert_eq!(mapped.revoke, vec!["old".to_string()]);
            assert_eq!(mapped.credential, Some(Credential { user: Some("me".to_string()), password: "pw".to_string() }));
            assert_eq!(mapped.delegated, None);
            let delegated = delegated();
            assert_eq!((delegated.delegated, delegated.credential, delegated.revoke), (Some(true), None, Vec::new()));
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
        assert_eq!(installer.install(&[], &KeyOptions::default()).await.outcome, KeyOutcome::Unavailable);
        assert_eq!(installer.enroll(&[], &KeyOptions::default()).await.outcome, KeyOutcome::Unavailable);
        assert_eq!(installer.enroll_delegated(&[]).await.outcome, KeyOutcome::Unavailable);
        assert_eq!(installer.revoke_delegated("key").await.outcome, KeyOutcome::Unavailable);
    }
}
