//! The production installer port against a scripted process runner: nothing is launched, installed or prompted.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use base64::Engine;

use super::super::installer::Credential;
use super::super::installer::KeyChangeOutcome;
use super::*;

type Call = (PathBuf, Vec<String>, Option<String>);
type Responder = Box<dyn Fn(&PathBuf, &[String]) -> Result<Exit, String> + Send + Sync>;

struct Scripted {
    calls: Arc<Mutex<Vec<Call>>>,
    respond: Responder,
}

impl ProcessRunner for Scripted {
    fn run(&self, program: PathBuf, args: Vec<String>, stdin: Option<String>) -> BoxFuture<Result<Exit, String>> {
        let answer = (self.respond)(&program, &args);
        self.calls.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push((program, args, stdin));
        Box::pin(async move { answer })
    }
}

fn exit(code: i32, stdout: &str) -> Result<Exit, String> {
    Ok(Exit { code, stdout: stdout.to_string() })
}

fn port(windows: bool, respond: Responder) -> (BridgePort, Arc<Mutex<Vec<Call>>>) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let runner = Arc::new(Scripted { calls: calls.clone(), respond });
    (BridgePort::new(PathBuf::from("C:\\app\\mixdog-secure-desktop.exe"), runner, windows), calls)
}

fn calls_of(calls: &Arc<Mutex<Vec<Call>>>) -> Vec<Call> {
    calls.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn key(seed: u8) -> String {
    let mut bytes = vec![4u8];
    bytes.extend((0..64).map(|index| seed.wrapping_add(index)));
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn op(verb: KeyVerb) -> KeyOp {
    KeyOp { verb, keys: strings(&["k1"]), revoke: strings(&["r1"]), credential: None, delegated: None }
}

#[test]
fn the_check_exit_codes_read_as_the_install_states() {
    assert_eq!(install_state_from_check_exit(0), InstallState::Installed);
    assert_eq!(install_state_from_check_exit(1), InstallState::NotInstalled);
    assert_eq!(install_state_from_check_exit(2), InstallState::Outdated);
    assert_eq!(install_state_from_check_exit(4), InstallState::OtherUser);
    assert_eq!(install_state_from_check_exit(7), InstallState::NotEnrolled);
    for other in [3, 5, 6, 8, 75, 1223, -1] {
        assert_eq!(install_state_from_check_exit(other), InstallState::Unavailable);
    }
}

#[tokio::test]
async fn check_runs_the_bridge_with_the_phones_key_and_reads_its_exit_code() {
    let (port, calls) = port(true, Box::new(|_, _| exit(7, "")));
    assert_eq!(port.check(Some("K".to_string())).await, InstallState::NotEnrolled);
    assert_eq!(port.check(None).await, InstallState::NotEnrolled);
    let seen = calls_of(&calls);
    assert_eq!(seen[0].0, PathBuf::from("C:\\app\\mixdog-secure-desktop.exe"));
    assert_eq!(seen[0].1, strings(&["check", "--controller-key", "K"]));
    assert_eq!(seen[1].1, strings(&["check"]));
}

#[tokio::test]
async fn a_check_that_cannot_run_is_unavailable() {
    let (port, _) = port(true, Box::new(|_, _| Err("spawn failed".to_string())));
    assert_eq!(port.check(None).await, InstallState::Unavailable);
}

#[tokio::test]
async fn off_windows_nothing_runs() {
    let (port, calls) = port(false, Box::new(|_, _| exit(0, "")));
    assert_eq!(port.check(Some("K".to_string())).await, InstallState::Unavailable);
    assert!(matches!(port.verify_image().await, ImageCheck::Refused { .. }));
    assert_eq!(port.start_service().await, HelperStatus { installed: false, running: false, version: None });
    assert!(port.run_key_op(op(KeyVerb::Install)).await.is_err());
    assert!(calls_of(&calls).is_empty());
}

#[tokio::test]
async fn verify_image_passes_on_exit_zero_and_refuses_with_the_bridges_own_reason() {
    let (ok, _) = port(true, Box::new(|_, _| exit(0, "")));
    assert_eq!(ok.verify_image().await, ImageCheck::Ok);
    let (refused, calls) = port(true, Box::new(|_, _| exit(5, "noise\n{\"error\":\"not pinned\"}\n\n")));
    assert_eq!(refused.verify_image().await, ImageCheck::Refused { detail: "not pinned".to_string() });
    assert_eq!(calls_of(&calls)[0].1, strings(&["verify-image"]));
    let (bare, _) = port(true, Box::new(|_, _| exit(9, "not json")));
    assert_eq!(bare.verify_image().await, ImageCheck::Refused { detail: "the helper exited with 9".to_string() });
    let (failed, _) = port(true, Box::new(|_, _| Err("no such file".to_string())));
    assert_eq!(failed.verify_image().await, ImageCheck::Refused { detail: "no such file".to_string() });
}

#[tokio::test]
async fn start_reads_the_last_json_line_even_when_the_bridge_exits_non_zero() {
    let (running, calls) = port(true, Box::new(|_, _| exit(0, "{\"installed\":false}\n{\"installed\":true,\"running\":true,\"version\":\"1.2\"}\n")));
    assert_eq!(running.start_service().await, HelperStatus { installed: true, running: true, version: Some("1.2".to_string()) });
    assert_eq!(calls_of(&calls)[0].1, strings(&["start"]));
    let (stalled, _) = port(true, Box::new(|_, _| exit(3, "{\"installed\":true,\"running\":false}")));
    assert_eq!(stalled.start_service().await, HelperStatus { installed: true, running: false, version: None });
    let (garbled, _) = port(true, Box::new(|_, _| exit(0, "garbage")));
    assert_eq!(garbled.start_service().await, HelperStatus { installed: false, running: false, version: None });
    let (broken, _) = port(true, Box::new(|_, _| Err("x".to_string())));
    assert_eq!(broken.start_service().await, HelperStatus { installed: false, running: false, version: None });
}

#[test]
fn key_op_args_add_the_revokes_except_for_a_revoke() {
    let keys = strings(&["a", "b"]);
    let revoke = strings(&["r"]);
    assert_eq!(key_op_args(KeyVerb::Install, &keys, &revoke), strings(&["--controller-key", "a", "--controller-key", "b", "--revoke-key", "r"]));
    assert_eq!(key_op_args(KeyVerb::Enroll, &keys[..1], &revoke), strings(&["--controller-key", "a", "--revoke-key", "r"]));
    assert_eq!(key_op_args(KeyVerb::Revoke, &keys[..1], &revoke), strings(&["--controller-key", "a"]));
}

#[tokio::test]
async fn an_elevated_op_runs_the_bridge_through_powershell_runas_and_returns_its_exit_code() {
    let (port, calls) = port(true, Box::new(|_, _| exit(1223, "")));
    assert_eq!(port.run_key_op(op(KeyVerb::Install)).await, Ok(1223));
    let (program, args, stdin) = calls_of(&calls).remove(0);
    assert_eq!(program, PathBuf::from("powershell"));
    assert_eq!(&args[..5], strings(&["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]).as_slice());
    let script = &args[5];
    assert!(script.contains("Start-Process -FilePath 'C:\\app\\mixdog-secure-desktop.exe' -ArgumentList @('install','--controller-key','k1','--revoke-key','r1') -Verb RunAs"));
    assert!(script.contains("NativeErrorCode -eq 1223) { exit 1223 }"));
    assert!(script.ends_with("$p.WaitForExit()\nexit $p.ExitCode"));
    assert!(stdin.is_none());
}

#[test]
fn the_elevation_script_doubles_a_single_quote_in_the_path_and_the_arguments() {
    let script = elevation_script("C:\\O'Neil\\b.exe", &strings(&["enroll", "it's"]));
    assert!(script.contains("-FilePath 'C:\\O''Neil\\b.exe' -ArgumentList @('enroll','it''s')"));
}

#[tokio::test]
async fn a_delegated_enroll_or_revoke_runs_unelevated_with_the_delegated_flag() {
    let (port, calls) = port(true, Box::new(|_, _| exit(21, "")));
    let mut enroll = op(KeyVerb::Enroll);
    enroll.delegated = Some(true);
    assert_eq!(port.run_key_op(enroll).await, Ok(21));
    let mut revoke = op(KeyVerb::Revoke);
    revoke.delegated = Some(true);
    assert_eq!(port.run_key_op(revoke).await, Ok(21));
    let seen = calls_of(&calls);
    assert_eq!(seen[0].0, PathBuf::from("C:\\app\\mixdog-secure-desktop.exe"));
    assert_eq!(seen[0].1, strings(&["enroll", "--controller-key", "k1", "--revoke-key", "r1", "--delegated"]));
    assert_eq!(seen[1].1, strings(&["revoke", "--controller-key", "k1", "--delegated"]));
    assert!(seen[0].2.is_none());
}

#[tokio::test]
async fn delegation_is_for_enroll_and_revoke_only_an_install_still_asks_for_elevation() {
    let (port, calls) = port(true, Box::new(|_, _| exit(0, "")));
    let mut install = op(KeyVerb::Install);
    install.delegated = Some(true);
    assert_eq!(port.run_key_op(install).await, Ok(0));
    assert_eq!(calls_of(&calls)[0].0, PathBuf::from("powershell"));
}

#[tokio::test]
async fn a_credential_op_logs_on_with_the_password_on_stdin_only() {
    let (port, calls) = port(true, Box::new(|_, _| exit(10, "")));
    let mut with_user = op(KeyVerb::Install);
    with_user.credential = Some(Credential { user: Some("PC\\me".to_string()), password: "pw".to_string() });
    assert_eq!(port.run_key_op(with_user).await, Ok(10));
    let mut own_account = op(KeyVerb::Enroll);
    own_account.credential = Some(Credential { user: None, password: "pw2".to_string() });
    assert_eq!(port.run_key_op(own_account).await, Ok(10));
    let seen = calls_of(&calls);
    assert_eq!(seen[0].0, PathBuf::from("C:\\app\\mixdog-secure-desktop.exe"));
    assert_eq!(seen[0].1, strings(&["install", "--controller-key", "k1", "--revoke-key", "r1", "--logon"]));
    assert!(seen[0].1.iter().all(|argument| !argument.contains("pw")));
    assert_eq!(seen[0].2.as_deref(), Some("PC\\me\npw"));
    assert_eq!(seen[1].2.as_deref(), Some("\npw2"));
}

#[tokio::test]
async fn a_launch_error_is_the_ops_error() {
    let (port, _) = port(true, Box::new(|_, _| Err("could not start".to_string())));
    assert_eq!(port.run_key_op(op(KeyVerb::Install)).await, Err("could not start".to_string()));
}

#[tokio::test]
async fn the_helper_installs_through_the_bridge_when_the_image_passes_and_the_service_is_missing() {
    let state = Arc::new(Mutex::new(1));
    let seen_state = state.clone();
    let (port, calls) = port(
        true,
        Box::new(move |program, args| match args.first().map(String::as_str) {
            Some("verify-image") => exit(0, ""),
            Some("check") => exit(*seen_state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()), ""),
            _ if program == &PathBuf::from("powershell") => {
                *seen_state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = 0;
                exit(0, "")
            }
            _ => exit(99, ""),
        }),
    );
    let helper = PcAccessHelper::over(Arc::new(port));
    let phone = key(1);
    let result = helper.install(vec![phone.clone()], KeyChangeOptions { revoke: vec![key(2)], ..KeyChangeOptions::default() }).await;
    assert_eq!(result.outcome, KeyChangeOutcome::Installed);
    assert_eq!(result.state, InstallState::Installed);
    assert_eq!(helper.state(Some(phone)).await, InstallState::Installed);
    let programs: Vec<String> = calls_of(&calls).iter().map(|(program, args, _)| format!("{}:{}", program.display(), args[0])).collect();
    assert_eq!(programs[0], "C:\\app\\mixdog-secure-desktop.exe:verify-image");
    assert!(programs.iter().any(|call| call.starts_with("powershell:")));
}
