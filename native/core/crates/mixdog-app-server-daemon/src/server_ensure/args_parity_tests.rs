//! The desktop's wire (`mixdog_ssh::install_wire`) cannot drift from `server_ensure` without one of
//! these failing: what the desktop encodes parses here to the same values, and every error code
//! the server prints is one the desktop knows.

use mixdog_ssh::install_wire as wire;

use super::CleanupPhase;
use super::DrainReport;
use super::EnsureError;
use super::Mode;
use super::ModelLogin;
use super::ProgramArgs;

fn mode(wire_mode: wire::Mode) -> Mode {
    match wire_mode {
        wire::Mode::Probe => Mode::Probe,
        wire::Mode::Ensure => Mode::Ensure,
        wire::Mode::Cleanup => Mode::Cleanup,
    }
}

fn phase(wire_phase: wire::CleanupPhase) -> CleanupPhase {
    match wire_phase {
        wire::CleanupPhase::Stop => CleanupPhase::Stop,
        wire::CleanupPhase::Remove => CleanupPhase::Remove,
    }
}

fn login(wire_login: wire::ModelLogin) -> ModelLogin {
    match wire_login {
        wire::ModelLogin::Server => ModelLogin::Server,
    }
}

fn parsed(args: &wire::ProgramArgs) -> ProgramArgs {
    ProgramArgs::decode(&wire::encode_program_args(args)).expect("the server parses what the desktop encodes")
}

#[test]
fn every_mode_phase_and_login_the_desktop_builds_parses_to_the_same_values() {
    let modes = [wire::Mode::Probe, wire::Mode::Ensure, wire::Mode::Cleanup];
    let phases = [None, Some(wire::CleanupPhase::Stop), Some(wire::CleanupPhase::Remove)];
    let logins = [None, Some(wire::ModelLogin::Server)];
    for wire_mode in modes {
        for wire_phase in phases {
            for wire_login in logins {
                for upload in [false, true] {
                    let mut args = wire::ProgramArgs::new(wire_mode, "1.4.6", "abc");
                    args.phase = wire_phase;
                    args.model_login = wire_login;
                    args.upload = upload;
                    args.sha256 = upload.then(|| "a".repeat(64));
                    args.bundle_sha256 = upload.then(|| "b".repeat(64));
                    args.confirm_token = upload.then(|| "token".to_owned());
                    args.remove_user_data = upload;
                    args.lock_wait_ms = upload.then_some(wire::REMOTE_INSTALL_LOCK_WAIT_MS);
                    args.lock_stale_ms = upload.then_some(wire::REMOTE_INSTALL_LOCK_STALE_MS);

                    let server = parsed(&args);
                    assert_eq!(server.mode, mode(wire_mode));
                    assert_eq!(server.install_id, "1.4.6-abc");
                    assert_eq!((server.version.as_str(), server.build.as_str()), ("1.4.6", "abc"));
                    assert_eq!(server.upload, upload);
                    assert_eq!(server.sha256, args.sha256);
                    assert_eq!(server.confirm_token, args.confirm_token);
                    assert_eq!(server.model_login, wire_login.map(login));
                    assert_eq!(server.phase, wire_phase.map(phase));
                    assert_eq!(server.remove_user_data, upload);
                    assert_eq!(server.lock_wait_ms, args.lock_wait_ms);
                    assert_eq!(server.lock_stale_ms, args.lock_stale_ms);
                    assert_eq!(server.wants_model_proxy(), wire_login.is_none());
                }
            }
        }
    }
}

#[test]
fn every_error_code_the_server_prints_is_a_bootstrap_code() {
    let drain = DrainReport { drain_id: "d".into(), running: Vec::new(), confirm_token: "t".into() };
    let errors = [
        EnsureError::InstallLocked { lock: "l".into(), owner: "o".into() },
        EnsureError::InstallFailed("x".into()),
        EnsureError::InstallMissing("1.4.6-abc".into()),
        EnsureError::ChecksumMismatch { expected: "a".into(), actual: "b".into() },
        EnsureError::UnsafeInstallId("../x".into()),
        EnsureError::BadVersion("x".into()),
        EnsureError::CoreExited { status: "1".into(), log: "l".into(), tail: "t".into() },
        EnsureError::Core("x".into()),
        EnsureError::DaemonUnproven("x".into()),
        EnsureError::DaemonStop(1),
        EnsureError::ClientOutdated { desktop_version: "1".into(), server_version: "2".into() },
        EnsureError::Busy { server_version: "1".into(), drain },
        EnsureError::Arguments("x".into()),
    ];
    for error in errors {
        assert!(
            wire::BootstrapCode::parse(error.code()).is_some(),
            "the desktop does not know the server's error code {}",
            error.code()
        );
    }
}

#[test]
fn the_drain_the_server_prints_is_the_drain_the_desktop_reads() {
    let drain = DrainReport { drain_id: "d1".into(), running: Vec::new(), confirm_token: "tok".into() };
    let line = serde_json::to_string(&drain).expect("drains serialize");
    let read: wire::RemoteDrain = serde_json::from_str(&line).expect("the desktop reads a drain");
    assert_eq!((read.drain_id.as_str(), read.confirm_token.as_str()), ("d1", "tok"));
    assert!(read.running.is_empty());
}
