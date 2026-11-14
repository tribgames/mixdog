//! The wire of the remote install (LR §8.1): what the desktop sends to the server program, what
//! it reads back, and the one `sh` script that runs on the server. The serde mirrors below
//! serialize to bytes `mixdog_app_server_daemon::server_ensure::ProgramArgs` parses; the
//! daemon's `args_parity_tests` fails when the two drift.
//!
//! The script is POSIX `sh` only: it probes the platform, unpacks the uploaded bundle
//! (`mixdogd` and its JS runtime) privately after checking its sha256 and hands everything else
//! to `mixdogd server-ensure <args>`: the install lock, the version decision, replacing or
//! starting the core and the garbage collection live there, in Rust, never in this script.
//!
//! Contract with `mixdogd server-ensure`: one argument (the base64 JSON of [`ProgramArgs`]);
//! stdout `MIXDOG_RESULT <json>` (last such line wins) or `MIXDOG_ERROR <code> <message>`
//! (preceded by `MIXDOG_DRAIN <json>` while an older core still runs work); exit 0 / 3.

use std::collections::BTreeMap;
use std::io;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_app_server_client::ctl::RunningWork;
use serde::Deserialize;
use serde::Serialize;

#[cfg(test)]
#[path = "install_tests.rs"]
mod install_tests;

/// Server-side directory, relative to the remote `$HOME`, holding every desktop-installed artifact.
pub const REMOTE_STATE_DIRECTORY: &str = ".mixdog-remote";

/// How long an ensure run waits for another holder of the install lock before `install-locked`,
/// and when a holder is presumed crashed.
pub const REMOTE_INSTALL_LOCK_WAIT_MS: u64 = 240_000;
pub const REMOTE_INSTALL_LOCK_STALE_MS: u64 = 15 * 60_000;

/// The runtime manifest the staging script writes next to the bundles.
pub const SERVER_MANIFEST_FILE: &str = "servers.json";

// ---------------------------------------------------------------------------------------------
// Program arguments (mirrors of server_ensure/args.rs)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Probe,
    Ensure,
    Cleanup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupPhase {
    /// Retire the core only (progress for the UI).
    Stop,
    /// Retire the core, prove nothing runs from the install, delete.
    Remove,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelLogin {
    /// The core runs models with the server's own logins (no model proxy).
    Server,
}

/// Arguments of one `server-ensure` run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramArgs {
    pub mode: Mode,
    /// `<version>-<build>`: the version directory name.
    pub install_id: String,
    pub version: String,
    pub build: String,
    /// The bundle (gzip tar of `mixdogd` and `payload/`, its sha256 `bundle_sha256`) follows on
    /// stdin; the bootstrap checks and unpacks it and runs `server-ensure` from the unpacked
    /// `mixdogd`, whose own sha256 is `sha256`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub upload: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_sha256: Option<String>,
    /// ensure: the user confirmed aborting the running work the last drain listed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_token: Option<String>,
    /// probe/ensure: `server` wants a core that runs models with the server's own logins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_login: Option<ModelLogin>,
    /// cleanup: `stop` stops the core only; `remove` also deletes files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<CleanupPhase>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub remove_user_data: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_wait_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_stale_ms: Option<u64>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl ProgramArgs {
    /// Arguments of `mode` for the install `version`/`build`, everything else unset.
    pub fn new(mode: Mode, version: &str, build: &str) -> Self {
        Self {
            mode,
            install_id: format!("{version}-{build}"),
            version: version.to_owned(),
            build: build.to_owned(),
            upload: false,
            sha256: None,
            bundle_sha256: None,
            confirm_token: None,
            model_login: None,
            phase: None,
            remove_user_data: false,
            lock_wait_ms: None,
            lock_stale_ms: None,
        }
    }
}

/// The base64 JSON that is the one argument of `mixdogd server-ensure`.
pub fn encode_program_args(args: &ProgramArgs) -> String {
    // A struct of strings, numbers and unit enums always serializes.
    let json = serde_json::to_vec(args).unwrap_or_default();
    STANDARD.encode(json)
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/// Every `code` a bootstrap or install failure carries: the server program's `MIXDOG_ERROR`
/// codes (`server_ensure::EnsureError::code`) and the desktop-side checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BootstrapCode {
    InstallLocked,
    InstallFailed,
    InstallMissing,
    ChecksumMismatch,
    Protocol,
    CoreExited,
    CoreControl,
    DaemonUnproven,
    DaemonStop,
    ClientOutdated,
    DaemonBusyOtherVersion,
    DaemonModelLogin,
    ProtocolMismatch,
    UnsupportedPlatform,
    DaemonUnmanaged,
    DaemonDataInUse,
    PortUnavailable,
    LocalPayload,
}

impl BootstrapCode {
    pub const ALL: [BootstrapCode; 18] = [
        BootstrapCode::InstallLocked,
        BootstrapCode::InstallFailed,
        BootstrapCode::InstallMissing,
        BootstrapCode::ChecksumMismatch,
        BootstrapCode::Protocol,
        BootstrapCode::CoreExited,
        BootstrapCode::CoreControl,
        BootstrapCode::DaemonUnproven,
        BootstrapCode::DaemonStop,
        BootstrapCode::ClientOutdated,
        BootstrapCode::DaemonBusyOtherVersion,
        BootstrapCode::DaemonModelLogin,
        BootstrapCode::ProtocolMismatch,
        BootstrapCode::UnsupportedPlatform,
        BootstrapCode::DaemonUnmanaged,
        BootstrapCode::DaemonDataInUse,
        BootstrapCode::PortUnavailable,
        BootstrapCode::LocalPayload,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            BootstrapCode::InstallLocked => "install-locked",
            BootstrapCode::InstallFailed => "install-failed",
            BootstrapCode::InstallMissing => "install-missing",
            BootstrapCode::ChecksumMismatch => "checksum-mismatch",
            BootstrapCode::Protocol => "protocol",
            BootstrapCode::CoreExited => "core-exited",
            BootstrapCode::CoreControl => "core-control",
            BootstrapCode::DaemonUnproven => "daemon-unproven",
            BootstrapCode::DaemonStop => "daemon-stop",
            BootstrapCode::ClientOutdated => "client-outdated",
            BootstrapCode::DaemonBusyOtherVersion => "daemon-busy-other-version",
            BootstrapCode::DaemonModelLogin => "daemon-model-login",
            BootstrapCode::ProtocolMismatch => "protocol-mismatch",
            BootstrapCode::UnsupportedPlatform => "unsupported-platform",
            BootstrapCode::DaemonUnmanaged => "daemon-unmanaged",
            BootstrapCode::DaemonDataInUse => "daemon-data-in-use",
            BootstrapCode::PortUnavailable => "port-unavailable",
            BootstrapCode::LocalPayload => "local-payload",
        }
    }

    /// `None` for a code this build does not know (a newer server's).
    pub fn parse(code: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|known| known.as_str() == code)
    }

    /// Failures only a change on the server (or a user decision) fixes: re-running the ssh
    /// probe cannot help, so the connection stops until it is reopened.
    pub fn is_terminal(self) -> bool {
        TERMINAL_BOOTSTRAP_CODES.contains(&self)
    }
}

/// See [`BootstrapCode::is_terminal`].
pub const TERMINAL_BOOTSTRAP_CODES: &[BootstrapCode] = &[
    BootstrapCode::DaemonModelLogin,
    BootstrapCode::ProtocolMismatch,
    BootstrapCode::UnsupportedPlatform,
    // This desktop is older than the core on the server: it never installs, so it never
    // downgrades (LR §8.1). Only updating this PC fixes it.
    BootstrapCode::ClientOutdated,
    BootstrapCode::DaemonBusyOtherVersion,
    BootstrapCode::DaemonUnmanaged,
    BootstrapCode::DaemonDataInUse,
    BootstrapCode::InstallLocked,
    BootstrapCode::PortUnavailable,
    // This PC's own runtime payload is missing or unusable: nothing was sent to the server, and
    // redialing cannot restore a local file.
    BootstrapCode::LocalPayload,
];

/// An older core winding down for a replace (`core/drain`, LR §5.1): what the user is shown and
/// the token that authorizes aborting exactly that work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDrain {
    pub drain_id: String,
    pub confirm_token: String,
    pub running: Vec<RunningWork>,
}

/// A bootstrap or install step on the server failed with a contract `code` (the server
/// program's `MIXDOG_ERROR` code or a desktop-side check). `detail` is the drain of
/// `daemon-busy-other-version`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct RemoteBootstrapError {
    pub code: String,
    pub message: String,
    pub detail: Option<RemoteDrain>,
}

impl RemoteBootstrapError {
    pub fn new(code: BootstrapCode, message: impl Into<String>) -> Self {
        Self { code: code.as_str().to_owned(), message: message.into(), detail: None }
    }

    /// A code read off the wire, known or not.
    pub fn from_wire(code: &str, message: impl Into<String>, detail: Option<RemoteDrain>) -> Self {
        Self { code: code.to_owned(), message: message.into(), detail }
    }

    pub fn is_terminal(&self) -> bool {
        BootstrapCode::parse(&self.code).is_some_and(BootstrapCode::is_terminal)
    }
}

/// An error from reading this PC's own files (the staged server runtimes). A failed ssh spawn is
/// not one: the caller reads this only from the file it opened.
pub fn is_local_filesystem_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound
            | io::ErrorKind::PermissionDenied
            | io::ErrorKind::IsADirectory
            | io::ErrorKind::NotADirectory
    )
}

// ---------------------------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ServerOs {
    Linux,
    Darwin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ServerArch {
    X64,
    Arm64,
}

/// A server the install supports: Linux x64/arm64 on glibc and macOS x64/arm64, the `mixdogd`
/// binaries the desktop ships. musl and Windows servers stop with `unsupported-platform`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ServerPlatform {
    pub os: ServerOs,
    pub arch: ServerArch,
}

impl ServerPlatform {
    /// `<os>-<arch>`: the key of `servers.json` and the bundle's folder.
    pub fn key(self) -> String {
        let os = match self.os {
            ServerOs::Linux => "linux",
            ServerOs::Darwin => "darwin",
        };
        let arch = match self.arch {
            ServerArch::X64 => "x64",
            ServerArch::Arm64 => "arm64",
        };
        format!("{os}-{arch}")
    }
}

/// Prints `MIXDOG_PLATFORM <uname -s> <uname -m>|<libc>` before node is even looked for, so an
/// unsupported server is named as such.
pub const REMOTE_PLATFORM_PROBE_SHELL: &str = r##"
MIXDOG_LIBC=none
if [ "$(uname -s 2>/dev/null)" = Linux ]; then
  if [ -e /etc/alpine-release ] || ls /lib/ld-musl-* /usr/lib/ld-musl-* >/dev/null 2>&1 || { ldd --version 2>&1 | grep -qi musl; }; then
    MIXDOG_LIBC=musl
  elif getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
    MIXDOG_LIBC=glibc
  else
    MIXDOG_LIBC=unknown
  fi
fi
printf 'MIXDOG_PLATFORM %s|%s\n' "$(uname -sm 2>/dev/null)" "$MIXDOG_LIBC"
"##;

const UNSUPPORTED_HINT: &str = "Mixdog servers need Linux (x64 or arm64, glibc) or macOS (x64 or arm64).";

/// stderr of a command line a Windows OpenSSH server (cmd.exe/PowerShell) refused.
pub fn is_windows_shell_failure(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("is not recognized as an internal or external command")
        || ["'sh'", "sh", "'sh", "sh'"]
            .iter()
            .any(|sh| lower.contains(&format!("the term {sh} is not recognized")))
        || lower.contains("commandnotfoundexception")
}

pub fn windows_server_error() -> RemoteBootstrapError {
    RemoteBootstrapError::new(
        BootstrapCode::UnsupportedPlatform,
        format!("The server runs Windows. {UNSUPPORTED_HINT}"),
    )
}

/// The probe line `(uname, libc)`, or `None` when the output carries none.
pub fn parse_platform_line(stdout: &str) -> Option<(String, String)> {
    stdout.lines().find_map(|line| {
        let rest = line.strip_prefix("MIXDOG_PLATFORM ")?.trim_end();
        let (uname, libc) = rest.rsplit_once('|')?;
        if libc.contains(char::is_whitespace) {
            return None;
        }
        Some((uname.trim().to_owned(), libc.to_owned()))
    })
}

/// Supported platform, or `unsupported-platform` naming what was found.
pub fn classify_platform(uname: &str, libc: &str) -> Result<ServerPlatform, RemoteBootstrapError> {
    let mut words = uname.split_whitespace();
    let system = words.next().unwrap_or("");
    let machine = words.next().unwrap_or("");
    let unsupported = |found: String| {
        RemoteBootstrapError::new(
            BootstrapCode::UnsupportedPlatform,
            format!("The server is {found}. {UNSUPPORTED_HINT}"),
        )
    };
    let lower_system = system.to_lowercase();
    if ["mingw", "msys", "cygwin", "windows"].iter().any(|prefix| lower_system.starts_with(prefix)) {
        return Err(unsupported(format!("Windows ({uname})")));
    }
    let os = match system {
        "Linux" => ServerOs::Linux,
        "Darwin" => ServerOs::Darwin,
        _ => {
            return Err(unsupported(if uname.is_empty() {
                "an unknown system (uname printed nothing)".to_owned()
            } else {
                uname.to_owned()
            }));
        }
    };
    let arch = if machine.eq_ignore_ascii_case("x86_64") || machine.eq_ignore_ascii_case("amd64") {
        ServerArch::X64
    } else if machine.eq_ignore_ascii_case("aarch64") || machine.eq_ignore_ascii_case("arm64") {
        ServerArch::Arm64
    } else {
        let cpu = if machine.is_empty() { "an unknown CPU" } else { machine };
        return Err(unsupported(format!("{system} on {cpu}")));
    };
    if os == ServerOs::Linux && libc == "musl" {
        return Err(unsupported(format!("{system} {machine} with musl libc (Alpine or similar)")));
    }
    Ok(ServerPlatform { os, arch })
}

// ---------------------------------------------------------------------------------------------
// The program
// ---------------------------------------------------------------------------------------------

const FAIL_SHELL: &str = r#"fail() { printf 'MIXDOG_ERROR %s %s\n' "$1" "$2"; exit 3; }"#;

/// Not installed: the probe still reports where the server's home is.
const PROBE_NOT_INSTALLED_SHELL: &str = r##"
HOME_JSON=$(printf %s "$HOME" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
printf 'MIXDOG_RESULT {"home":"%s","uid":%s,"installed":false}\n' "$HOME_JSON" "$(id -u)"
"##;

/// The part of the script that keeps the upload in a private file, checks its digest (the
/// placeholder `@BUNDLE_SHA256@`, replaced by the quoted digest), unpacks it (still under
/// `$ROOT`, so the install can move `payload/` by rename) and runs `server-ensure` from the
/// unpacked `mixdogd`. Both are removed on every exit.
pub const REMOTE_PROGRAM: &str = r##"
command -v gzip >/dev/null 2>&1 || fail install-failed "gzip was not found on the server."
command -v tar >/dev/null 2>&1 || fail install-failed "tar was not found on the server."
if command -v sha256sum >/dev/null 2>&1; then SHA_TOOL="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHA_TOOL="shasum -a 256"
else fail install-failed "Neither sha256sum nor shasum was found on the server."; fi
mkdir -p "$ROOT/tmp" && chmod 700 "$ROOT" "$ROOT/tmp" 2>/dev/null
WORK="$ROOT/tmp/upload.$$"
BUNDLE="$WORK.tgz"
trap 'rm -rf "$WORK" "$BUNDLE"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$BUNDLE" || fail install-failed "The uploaded Mixdog runtime could not be stored on the server."
ACTUAL=$($SHA_TOOL "$BUNDLE" | cut -d' ' -f1)
[ "$ACTUAL" = @BUNDLE_SHA256@ ] || fail install-failed "The uploaded Mixdog runtime does not match its digest."
mkdir -m 700 "$WORK" || fail install-failed "The upload directory could not be created on the server."
gzip -dc < "$BUNDLE" | tar -xf - -C "$WORK" || fail install-failed "The uploaded Mixdog runtime could not be unpacked on the server."
chmod 700 "$WORK/mixdogd" || fail install-failed "The uploaded Mixdog runtime holds no mixdogd."
chmod 755 "$WORK/payload/js/node" 2>/dev/null
"$WORK/mixdogd" server-ensure "$ARGS"
exit $?
"##;

/// POSIX single-quote quoting.
pub fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// `^[0-9A-Za-z][0-9A-Za-z.+_-]*$`: a path segment that cannot leave its directory.
pub fn is_safe_segment(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|first| first.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '_' | '-'))
}

fn is_sha256_hex(value: Option<&str>) -> bool {
    value.is_some_and(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// Platform probe, then the run: the installed `mixdogd`, or the uploaded one.
pub fn remote_program_script(args: &ProgramArgs) -> Result<String, RemoteBootstrapError> {
    if !is_safe_segment(&args.install_id) {
        return Err(RemoteBootstrapError::new(
            BootstrapCode::InstallFailed,
            format!("Server install id is not a safe path segment: {}", args.install_id),
        ));
    }
    if args.upload && !(is_sha256_hex(args.sha256.as_deref()) && is_sha256_hex(args.bundle_sha256.as_deref())) {
        return Err(RemoteBootstrapError::new(
            BootstrapCode::InstallFailed,
            "An upload needs the sha256 of the runtime and of its bundle.",
        ));
    }
    let head = [
        FAIL_SHELL.to_owned(),
        REMOTE_PLATFORM_PROBE_SHELL.to_owned(),
        format!(r#"ROOT="$HOME/{REMOTE_STATE_DIRECTORY}""#),
        format!(r#"INSTALLED="$ROOT/versions/{}/mixdogd""#, args.install_id),
        format!("ARGS={}", sh_quote(&encode_program_args(args))),
    ];
    if args.upload {
        let digest = sh_quote(args.bundle_sha256.as_deref().unwrap_or_default());
        let upload = REMOTE_PROGRAM.replace("@BUNDLE_SHA256@", &digest);
        return Ok([head.join("\n"), upload].join("\n"));
    }
    let installed = r#"exec "$INSTALLED" server-ensure "$ARGS""#;
    let mut lines = head.to_vec();
    if args.mode == Mode::Probe {
        lines.push(format!(r#"if [ -x "$INSTALLED" ]; then {installed}; fi"#));
        lines.push(PROBE_NOT_INSTALLED_SHELL.to_owned());
    } else {
        lines.push(
            r#"[ -x "$INSTALLED" ] || fail install-missing "The Mixdog runtime is not installed on the server and must be uploaded.""#
                .to_owned(),
        );
        lines.push(installed.to_owned());
        lines.push(String::new());
    }
    Ok(lines.join("\n"))
}

/// The command line handed to the user's login shell. Only base64 crosses it, inside single
/// quotes, so bash, zsh, fish and csh all pass the script to `sh` unchanged.
pub fn remote_shell_command(script: &str) -> String {
    let encoded = STANDARD.encode(script.as_bytes());
    format!(r#"sh -c 'eval "$(printf %s {encoded} | base64 -d)"'"#)
}

// ---------------------------------------------------------------------------------------------
// Manifest (`servers.json`, apps/desktop/src/main/ssh/server-manifest.mjs)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerBundleEntry {
    pub file: String,
    pub sha256: String,
    pub size: u64,
    /// Digest of the bundle's content (it carries the JS runtime).
    pub content: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerBinaryEntry {
    /// sha256 and size of the `mixdogd` binary.
    pub sha256: String,
    pub size: u64,
    /// `bundle.tgz`: that binary and the JS runtime it runs with.
    pub bundle: Option<ServerBundleEntry>,
}

/// `servers.json`: the release version, its build and one entry per `<os>-<arch>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerManifest {
    pub version: String,
    pub build: String,
    pub binaries: BTreeMap<String, ServerBinaryEntry>,
}

/// The build every platform's upload of one release shares: a digest of the per-platform
/// digests (the binary's and the content of its bundle), so a rebuilt binary or JS runtime of
/// any platform is a new build, while restaging the same inputs is not.
pub fn manifest_build(binaries: &BTreeMap<String, ServerBinaryEntry>) -> String {
    let mut lines = String::new();
    for (key, entry) in binaries {
        let content = entry.bundle.as_ref().map(|b| b.content.as_str()).unwrap_or("");
        lines.push_str(&format!("{key}:{}:{content}\n", entry.sha256));
    }
    sha256_hex(lines.as_bytes())[..16].to_owned()
}

/// Lowercase hex sha256.
pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(data).iter().map(|byte| format!("{byte:02x}")).collect()
}

impl ServerManifest {
    /// Parses and checks a manifest: a malformed one, or one whose `build` is not the digest of
    /// its binaries, is `local-payload`.
    pub fn parse(text: &str) -> Result<Self, RemoteBootstrapError> {
        let malformed =
            || RemoteBootstrapError::new(BootstrapCode::LocalPayload, "The server runtime manifest is malformed.");
        let manifest: Self = serde_json::from_str(text).map_err(|_| malformed())?;
        if !is_safe_segment(&manifest.version) || !is_safe_segment(&manifest.build) {
            return Err(malformed());
        }
        if manifest_build(&manifest.binaries) != manifest.build {
            return Err(RemoteBootstrapError::new(
                BootstrapCode::LocalPayload,
                "The server runtime manifest does not match its binaries.",
            ));
        }
        Ok(manifest)
    }

    /// The manifest of the release staged in `dir`.
    pub fn load<P: mixdog_fsio::ReadProof>(proof: &P, dir: &std::path::Path) -> Result<Self, RemoteBootstrapError> {
        let file = dir.join(SERVER_MANIFEST_FILE);
        let text = mixdog_fsio::read_to_string(proof, &file).map_err(|e| {
            RemoteBootstrapError::new(BootstrapCode::LocalPayload, format!("{} could not be read: {e}", file.display()))
        })?;
        Self::parse(&text)
    }

    /// `<version>-<build>`: the version directory name on the server.
    pub fn install_id(&self) -> String {
        format!("{}-{}", self.version, self.build)
    }
}
