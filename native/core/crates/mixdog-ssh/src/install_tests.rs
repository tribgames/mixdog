use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use super::*;
use crate::install_payload::InstallPayload;

/// `manifestBuild` of server-manifest.mjs over the binaries of `MANIFEST_JSON`.
const EXPECTED_BUILD: &str = "a888562fff32273b";

const MANIFEST_JSON: &str = r#"{
  "version": "1.4.6",
  "build": "a888562fff32273b",
  "binaries": {
    "linux-x64": { "sha256": "aa11", "size": 1, "bundle": { "file": "bundle.tgz", "sha256": "dd44", "size": 2, "content": "c1" } },
    "darwin-arm64": { "sha256": "bb22", "size": 1, "bundle": { "file": "bundle.tgz", "sha256": "ee55", "size": 2, "content": "c2" } },
    "linux-arm64": { "sha256": "cc33", "size": 1 }
  }
}"#;

#[test]
fn manifest_build_equals_what_the_js_computes() {
    let manifest: ServerManifest = serde_json::from_str(MANIFEST_JSON).unwrap();
    assert_eq!(manifest_build(&manifest.binaries), EXPECTED_BUILD);
    let parsed = ServerManifest::parse(MANIFEST_JSON).unwrap();
    assert_eq!(parsed.install_id(), "1.4.6-a888562fff32273b");
}

#[test]
fn manifest_that_does_not_match_its_binaries_is_local_payload() {
    let tampered = MANIFEST_JSON.replace("\"sha256\": \"aa11\"", "\"sha256\": \"aa12\"");
    assert_eq!(ServerManifest::parse(&tampered).unwrap_err().code, "local-payload");
    assert_eq!(ServerManifest::parse("{").unwrap_err().code, "local-payload");
    let unsafe_version = MANIFEST_JSON.replace("1.4.6", "../x");
    assert_eq!(ServerManifest::parse(&unsafe_version).unwrap_err().code, "local-payload");
}

#[test]
fn payload_resolves_the_bundle_of_the_platform() {
    let manifest = ServerManifest::parse(MANIFEST_JSON).unwrap();
    let darwin = classify_platform("Darwin arm64", "none").unwrap();
    let payload = InstallPayload::resolve(Path::new("cores"), &manifest, darwin).unwrap();
    assert_eq!(payload.bundle, Path::new("cores").join("darwin-arm64").join("bundle.tgz"));
    assert_eq!((payload.sha256.as_str(), payload.bundle_sha256.as_str()), ("bb22", "ee55"));
    assert_eq!(payload.install_id(), "1.4.6-a888562fff32273b");
    let absent = classify_platform("Darwin x86_64", "none").unwrap();
    assert_eq!(InstallPayload::resolve(Path::new("cores"), &manifest, absent).unwrap_err().code, "local-payload");
    let no_bundle = classify_platform("Linux aarch64", "glibc").unwrap();
    assert_eq!(InstallPayload::resolve(Path::new("cores"), &manifest, no_bundle).unwrap_err().code, "local-payload");
}

#[test]
fn classifies_the_supported_platforms() {
    let key = |uname, libc| classify_platform(uname, libc).unwrap().key();
    assert_eq!(key("Linux x86_64", "glibc"), "linux-x64");
    assert_eq!(key("Linux aarch64", "unknown"), "linux-arm64");
    assert_eq!(key("Darwin arm64", "none"), "darwin-arm64");
    assert_eq!(key("Darwin x86_64", "none"), "darwin-x64");
    assert_eq!(key("Linux AMD64", "glibc"), "linux-x64");
}

#[test]
fn refuses_the_unsupported_ones_by_name() {
    let message = |uname, libc| {
        let error = classify_platform(uname, libc).unwrap_err();
        assert_eq!(error.code, "unsupported-platform");
        error.message
    };
    assert!(message("Linux x86_64", "musl").contains("musl libc"));
    assert!(message("MINGW64_NT-10.0 x86_64", "none").contains("Windows (MINGW64_NT-10.0 x86_64)"));
    assert!(message("FreeBSD amd64", "none").starts_with("The server is FreeBSD amd64."));
    assert!(message("Linux riscv64", "glibc").contains("Linux on riscv64"));
    assert!(message("", "none").contains("uname printed nothing"));
    assert!(message("Linux", "glibc").contains("an unknown CPU"));
    // musl only matters on Linux.
    assert!(classify_platform("Darwin arm64", "musl").is_ok());
}

#[test]
fn reads_the_probe_line_and_the_windows_shell_failure() {
    let out = "noise\r\nMIXDOG_PLATFORM Linux x86_64|glibc\r\nMIXDOG_RESULT {}\n";
    assert_eq!(parse_platform_line(out), Some(("Linux x86_64".to_owned(), "glibc".to_owned())));
    assert_eq!(parse_platform_line("nothing"), None);
    assert!(is_windows_shell_failure("'sh' is not recognized as an internal or external command"));
    assert!(is_windows_shell_failure("The term 'sh' is not recognized as the name of a cmdlet"));
    assert!(is_windows_shell_failure("CommandNotFoundException"));
    assert!(!is_windows_shell_failure("Permission denied"));
    assert_eq!(windows_server_error().code, "unsupported-platform");
}

#[test]
fn terminal_codes_are_the_ones_a_redial_cannot_fix() {
    for code in BootstrapCode::ALL {
        assert_eq!(BootstrapCode::parse(code.as_str()), Some(code));
    }
    assert_eq!(TERMINAL_BOOTSTRAP_CODES.len(), 10);
    assert!(BootstrapCode::LocalPayload.is_terminal());
    assert!(!BootstrapCode::InstallFailed.is_terminal());
    assert!(!BootstrapCode::CoreExited.is_terminal());
    assert!(RemoteBootstrapError::from_wire("install-locked", "x", None).is_terminal());
    assert!(!RemoteBootstrapError::from_wire("something-new", "x", None).is_terminal());
    assert!(is_local_filesystem_error(&io::Error::from(io::ErrorKind::NotFound)));
    assert!(!is_local_filesystem_error(&io::Error::from(io::ErrorKind::ConnectionRefused)));
}

#[test]
fn quotes_for_sh() {
    assert_eq!(sh_quote("abc"), "'abc'");
    assert_eq!(sh_quote("it's"), r"'it'\''s'");
    assert!(is_safe_segment("1.4.6-abc"));
    assert!(!is_safe_segment("../x"));
    assert!(!is_safe_segment("-x"));
    assert!(!is_safe_segment(""));
}

#[test]
fn program_args_encode_as_camel_case_json_without_unset_fields() {
    let mut args = ProgramArgs::new(Mode::Ensure, "1.4.6", "abc");
    args.upload = true;
    args.model_login = Some(ModelLogin::Server);
    let json: serde_json::Value = serde_json::from_slice(&STANDARD.decode(encode_program_args(&args)).unwrap()).unwrap();
    assert_eq!(
        json,
        serde_json::json!({"mode":"ensure","installId":"1.4.6-abc","version":"1.4.6","build":"abc","upload":true,"modelLogin":"server"})
    );
}

fn upload_args() -> ProgramArgs {
    let mut args = ProgramArgs::new(Mode::Ensure, "1.4.6", "abc");
    args.upload = true;
    args.sha256 = Some("a".repeat(64));
    args.bundle_sha256 = Some("b".repeat(64));
    args
}

#[test]
fn the_script_runs_the_installed_or_the_uploaded_program() {
    let probe = remote_program_script(&ProgramArgs::new(Mode::Probe, "1.4.6", "abc")).unwrap();
    assert!(probe.contains(r#"INSTALLED="$ROOT/versions/1.4.6-abc/mixdogd""#));
    assert!(probe.contains(r#"if [ -x "$INSTALLED" ]; then exec "$INSTALLED" server-ensure "$ARGS"; fi"#));
    assert!(probe.contains(r#""installed":false"#));
    let ensure = remote_program_script(&ProgramArgs::new(Mode::Ensure, "1.4.6", "abc")).unwrap();
    assert!(ensure.contains("fail install-missing"));
    assert!(ensure.ends_with("server-ensure \"$ARGS\"\n"));
    let upload = remote_program_script(&upload_args()).unwrap();
    assert!(upload.contains(&format!("[ \"$ACTUAL\" = '{}' ]", "b".repeat(64))));
    assert!(upload.contains(r#""$WORK/mixdogd" server-ensure "$ARGS""#));
    assert!(!upload.contains("@BUNDLE_SHA256@"));
}

#[test]
fn the_script_refuses_what_it_cannot_run_safely() {
    let mut unsafe_id = ProgramArgs::new(Mode::Ensure, "1.4.6", "abc");
    unsafe_id.install_id = "x/../y".to_owned();
    assert!(remote_program_script(&unsafe_id).is_err());
    let mut no_digest = upload_args();
    no_digest.bundle_sha256 = None;
    assert!(remote_program_script(&no_digest).is_err());
}

#[test]
fn the_shell_command_carries_only_base64() {
    let command = remote_shell_command("echo 'x'");
    let encoded = STANDARD.encode("echo 'x'");
    assert_eq!(command, format!(r#"sh -c 'eval "$(printf %s {encoded} | base64 -d)"'"#));
}
