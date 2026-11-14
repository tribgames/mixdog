//! Bootstrap of a server connection (LR §8.1): probe the platform and the installed state, upload this desktop's
//! `mixdogd` when its version directory is missing, and let `mixdogd server-ensure` on the server decide, with the one
//! `compat::order`, whether the running core is attached to, replaced (this desktop is newer) or refused (this desktop
//! is older). Nothing here compares versions; the server's answer is the decision.
//!
//! Every run is one `ssh <target> <command>` ([`remote_shell_command`] of [`remote_program_script`]): the server prints
//! `MIXDOG_PLATFORM`, then `MIXDOG_RESULT <json>` or `MIXDOG_ERROR <code> <message>` (see [`install_wire`](crate::install_wire)).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Map, Value};

use crate::command::SshTarget;
use crate::connect_failure::ConnectError;
use crate::context::{AttemptContext, ModelLogin, SshEnv};
use crate::install_payload::InstallPayload;
use crate::install_wire::{
    BootstrapCode, Mode, ProgramArgs, RemoteBootstrapError, RemoteDrain, ServerManifest, ServerPlatform, classify_platform,
    is_windows_shell_failure, parse_platform_line, remote_program_script, remote_shell_command, windows_server_error,
    REMOTE_INSTALL_LOCK_STALE_MS, REMOTE_INSTALL_LOCK_WAIT_MS,
};
use crate::install_wire::ModelLogin as WireModelLogin;
use crate::spawn::{ExecOptions, ssh_exec};

#[cfg(test)]
#[path = "bootstrap_tests.rs"]
mod bootstrap_tests;

/// ssh run budgets of one bootstrap: the probe, then the ensure run that waits for the install lock and replaces or
/// starts the core, longer when it also uploads the runtime.
pub const REMOTE_PROBE_TIMEOUT: Duration = Duration::from_secs(60);
pub const REMOTE_ENSURE_TIMEOUT: Duration = Duration::from_secs(360);
pub const REMOTE_INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// `MIXDOG_ERROR` codes the desktop side raises itself and `BootstrapCode` does not list.
const REMOTE_SHELL: &str = "remote-shell";
const DAEMON_UNHEALTHY: &str = "daemon-unhealthy";

// ---------------------------------------------------------------------------------------------
// What the server reports
// ---------------------------------------------------------------------------------------------

/// The discovery file of the server's core (LR §4), as the desktop uses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDiscovery {
    /// The WebSocket listener; `None` while the core does not serve (no `rpc`).
    pub rpc_port: Option<u16>,
    /// The control listener (`/mgmt/*`, `/health`).
    pub control_port: u16,
    /// The one token that opens both listeners.
    pub token: String,
    pub pid: u32,
    pub instance_id: String,
    /// The OS start time of `pid`: with the pid it names this process, not a later one that reused the pid.
    pub process_start_time: String,
    pub state: String,
    pub version: String,
    pub build: String,
}

/// The core of an older version a run replaced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteReplaced {
    pub pid: u32,
    pub version: String,
    pub graceful: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteReport {
    pub home: String,
    pub uid: u32,
    pub runtime_root: String,
    /// The version directory this desktop's build installs into.
    pub version_dir: String,
    /// This build's `mixdogd` exists on the server.
    pub installed: bool,
    pub discovery: Option<RemoteDiscovery>,
    /// A core is serving (discovery names an RPC listener).
    pub healthy: bool,
    /// The serving core is this desktop's version and build, in the model login mode asked for.
    pub core_current: bool,
    /// This bootstrap run started the core (ensure mode only).
    pub started: bool,
    pub replaced: Option<RemoteReplaced>,
    /// Version directories the run garbage-collected.
    pub gc_removed: Vec<String>,
}

impl RemoteReport {
    /// The core's discovery with its serving RPC port.
    pub fn serving(&self) -> Option<(&RemoteDiscovery, u16)> {
        let discovery = self.discovery.as_ref()?;
        Some((discovery, discovery.rpc_port?))
    }
}

fn text_of(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// An integral JSON number (`41001` and `41001.0` alike, as JavaScript sees them).
fn integer_of(value: Option<&Value>) -> Option<i64> {
    let number = value?;
    if let Some(whole) = number.as_i64() {
        return Some(whole);
    }
    let float = number.as_f64().filter(|float| float.is_finite() && float.fract() == 0.0 && float.abs() < 9.0e15)?;
    Some(float as i64)
}

fn port_of(value: Option<&Value>) -> Option<u16> {
    integer_of(value).and_then(|port| u16::try_from(port).ok()).filter(|port| *port >= 1)
}

fn discovery_of(value: &Value) -> Option<RemoteDiscovery> {
    let record = value.as_object()?;
    let pid = integer_of(record.get("pid")).and_then(|pid| u32::try_from(pid).ok()).filter(|pid| *pid > 0)?;
    let token = text_of(record.get("endpoints").and_then(|endpoints| endpoints.get("session")).and_then(|session| session.get("token")))?;
    let core = record.get("core")?.as_object()?;
    let control_port = port_of(core.get("control").and_then(|control| control.get("port")))?;
    let field = |name: &str| text_of(core.get(name)).unwrap_or_default().to_owned();
    Some(RemoteDiscovery {
        rpc_port: port_of(core.get("rpc").and_then(|rpc| rpc.get("port"))),
        control_port,
        token: token.to_owned(),
        pid,
        instance_id: field("instanceId"),
        process_start_time: field("processStartTime"),
        state: field("state"),
        version: field("version"),
        build: field("build"),
    })
}

/// daemon.json as the core writes it (LR §4): `pid`, `endpoints.session.token` and the `core` block with the control
/// port and, while serving, the RPC port. `None` for text that is not such a document (a 1.4.5 daemon's file has no
/// `core` block).
pub fn parse_remote_discovery(text: &str) -> Option<RemoteDiscovery> {
    discovery_of(&serde_json::from_str::<Value>(text).ok()?)
}

/// The `daemonJson` of a result: the file's text, or the document itself.
fn discovery_from_result(value: &Value) -> Option<RemoteDiscovery> {
    match value {
        Value::String(text) => parse_remote_discovery(text),
        other => discovery_of(other),
    }
}

fn string_of(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn report_of(value: &Map<String, Value>) -> RemoteReport {
    let discovery = value.get("daemonJson").filter(|raw| !raw.is_null()).and_then(discovery_from_result);
    let healthy = value.get("healthy") == Some(&Value::Bool(true)) && discovery.as_ref().is_some_and(|found| found.rpc_port.is_some());
    let replaced = value.get("replaced").and_then(Value::as_object).map(|replaced| RemoteReplaced {
        pid: integer_of(replaced.get("pid")).and_then(|pid| u32::try_from(pid).ok()).unwrap_or(0),
        version: string_of(replaced.get("version")),
        graceful: replaced.get("graceful") == Some(&Value::Bool(true)),
    });
    RemoteReport {
        home: string_of(value.get("home")),
        uid: integer_of(value.get("uid")).and_then(|uid| u32::try_from(uid).ok()).unwrap_or(0),
        runtime_root: string_of(value.get("runtimeRoot")),
        version_dir: string_of(value.get("versionDir")),
        installed: value.get("installed") == Some(&Value::Bool(true)),
        discovery,
        healthy,
        core_current: healthy && value.get("coreCurrent") == Some(&Value::Bool(true)),
        started: value.get("started") == Some(&Value::Bool(true)),
        replaced,
        gc_removed: value
            .get("gcRemoved")
            .and_then(Value::as_array)
            .map(|dirs| dirs.iter().map(|dir| dir.as_str().map_or_else(|| dir.to_string(), str::to_owned)).collect())
            .unwrap_or_default(),
    }
}

struct ParsedOutput {
    value: Map<String, Value>,
    platform: Option<ServerPlatform>,
}

/// The last `MIXDOG_DRAIN` line, read as tolerantly as the server writes it: a listing without its id or token is none.
fn parse_drain_line(lines: &[&str]) -> Option<RemoteDrain> {
    let line = lines.iter().rev().find_map(|line| line.strip_prefix("MIXDOG_DRAIN "))?;
    let value: Value = serde_json::from_str(line).ok()?;
    let drain_id = value.get("drainId")?.as_str()?.to_owned();
    let confirm_token = value.get("confirmToken")?.as_str()?.to_owned();
    let running = value
        .get("running")
        .and_then(Value::as_array)
        .map(|work| {
            work.iter()
                .map(|item| mixdog_app_server_client::ctl::RunningWork {
                    kind: string_of(item.get("kind")),
                    thread_id: text_of(item.get("threadId")).map(str::to_owned),
                    turn_id: text_of(item.get("turnId")).map(str::to_owned),
                    title: string_of(item.get("title")),
                })
                .collect()
        })
        .unwrap_or_default();
    Some(RemoteDrain { drain_id, confirm_token, running })
}

/// The platform line first (an unsupported server is named as such even when a later step failed), then the last
/// `MIXDOG_RESULT` / `MIXDOG_ERROR` line.
fn parse_remote_output(stdout: &str) -> Result<ParsedOutput, RemoteBootstrapError> {
    let platform = match parse_platform_line(stdout) {
        Some((uname, libc)) => Some(classify_platform(&uname, &libc)?),
        None => None,
    };
    let lines: Vec<&str> = stdout.lines().collect();
    for line in lines.iter().rev() {
        if let Some(rest) = line.strip_prefix("MIXDOG_ERROR ") {
            if let Some((code, message)) = rest.split_once(' ').filter(|(code, _)| !code.is_empty() && !code.contains(char::is_whitespace)) {
                return Err(RemoteBootstrapError::from_wire(code, message, parse_drain_line(&lines)));
            }
        }
        let Some(result) = line.strip_prefix("MIXDOG_RESULT ") else { continue };
        // A torn result line is no result.
        if let Ok(Value::Object(value)) = serde_json::from_str::<Value>(result) {
            return Ok(ParsedOutput { value, platform });
        }
        break;
    }
    Err(RemoteBootstrapError::new(BootstrapCode::Protocol, "The server returned no bootstrap result."))
}

/// The report of a server run's stdout (tests and callers that ran the program themselves).
pub fn parse_remote_report(stdout: &str) -> Result<RemoteReport, RemoteBootstrapError> {
    Ok(report_of(&parse_remote_output(stdout)?.value))
}

// ---------------------------------------------------------------------------------------------
// The release this desktop uploads
// ---------------------------------------------------------------------------------------------

/// Which build of the server runtime this desktop carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerIdentity {
    pub version: String,
    pub build: String,
}

impl ServerIdentity {
    /// `<version>-<build>`: the version directory name on the server.
    pub fn install_id(&self) -> String {
        format!("{}-{}", self.version, self.build)
    }
}

/// The runtime to upload for one server platform, checked against the manifest.
pub struct ServerBinary {
    /// sha256 of the `mixdogd` inside the bundle.
    pub sha256: String,
    /// sha256 of the bundle, the wire form.
    pub bundle_sha256: String,
    pub archive: Vec<u8>,
}

/// Where the runtimes to upload come from. Reading the bundle is a blocking file read: it happens only when a run
/// uploads.
pub trait ServerPayloads: Sync {
    fn identity(&self) -> &ServerIdentity;
    /// `local-payload` when this desktop ships no runtime for the platform, or the bundle is damaged.
    fn binary(&self, platform: ServerPlatform) -> Result<ServerBinary, RemoteBootstrapError>;
}

/// The release staged in `SshEnv::server_cores_dir`, read under the proof of the lane job the caller runs in.
pub struct StagedPayloads<'a, P: mixdog_fsio::ReadProof> {
    proof: &'a P,
    dir: PathBuf,
    manifest: ServerManifest,
    identity: ServerIdentity,
}

impl<'a, P: mixdog_fsio::ReadProof> StagedPayloads<'a, P> {
    /// Reads and checks the release manifest; a malformed or missing one is `local-payload`.
    pub fn open(proof: &'a P, env: &SshEnv) -> Result<Self, RemoteBootstrapError> {
        let dir = env
            .server_cores_dir
            .clone()
            .ok_or_else(|| RemoteBootstrapError::new(BootstrapCode::LocalPayload, "This desktop has no staged Mixdog server runtimes."))?;
        let manifest = ServerManifest::load(proof, &dir)?;
        let identity = ServerIdentity { version: manifest.version.clone(), build: manifest.build.clone() };
        Ok(Self { proof, dir, manifest, identity })
    }
}

impl<P: mixdog_fsio::ReadProof + Sync> ServerPayloads for StagedPayloads<'_, P> {
    fn identity(&self) -> &ServerIdentity {
        &self.identity
    }

    fn binary(&self, platform: ServerPlatform) -> Result<ServerBinary, RemoteBootstrapError> {
        let payload = InstallPayload::resolve(&self.dir, &self.manifest, platform)?;
        let archive = payload.read_archive(self.proof)?;
        Ok(ServerBinary { sha256: payload.sha256, bundle_sha256: payload.bundle_sha256, archive })
    }
}

// ---------------------------------------------------------------------------------------------
// Running the server program
// ---------------------------------------------------------------------------------------------

/// What each server's last busy refusal listed. A user's confirmation reaches the server as that listing's token, so
/// it only ever aborts work the user was shown; a changed set is refused again with the new listing.
static PENDING_DRAINS: LazyLock<Mutex<BTreeMap<String, RemoteDrain>>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));

/// The first `MIXDOG_RESULT`, `MIXDOG_ERROR` or `MIXDOG_PLATFORM` line: the server program ran.
fn has_program_output(stdout: &str) -> bool {
    stdout.lines().any(|line| ["MIXDOG_RESULT ", "MIXDOG_ERROR ", "MIXDOG_PLATFORM "].iter().any(|marker| line.starts_with(marker)))
}

/// The server one attempt talks to.
#[derive(Clone, Copy)]
pub(crate) struct Remote<'a> {
    pub env: &'a SshEnv,
    pub context: &'a AttemptContext,
    pub target: &'a SshTarget,
}

impl Remote<'_> {
    /// One server program run over ssh: its raw `MIXDOG_RESULT` object and the server's platform.
    pub(crate) async fn run(
        self,
        args: &ProgramArgs,
        timeout: Duration,
        input: Option<Vec<u8>>,
    ) -> Result<(Map<String, Value>, ServerPlatform), ConnectError> {
        let command = remote_shell_command(&remote_program_script(args)?);
        let options = ExecOptions { target: self.target.clone(), command, input, timeout, context: Some(self.context.clone()) };
        let run = ssh_exec(self.env, options).await?;
        if run.exit_code != 0 && !has_program_output(&run.stdout) {
            if is_windows_shell_failure(&run.stderr) {
                return Err(windows_server_error().into());
            }
            let lines: Vec<&str> = run.stderr.trim().lines().collect();
            let detail = lines[lines.len().saturating_sub(6)..].join("
");
            let suffix = if detail.is_empty() { String::new() } else { format!("
{detail}") };
            return Err(RemoteBootstrapError::from_wire(
                REMOTE_SHELL,
                format!("Remote bootstrap exited with status {}.{suffix}", run.exit_code),
                None,
            )
            .into());
        }
        let ParsedOutput { value, platform } = parse_remote_output(&run.stdout)?;
        let platform =
            platform.ok_or_else(|| RemoteBootstrapError::new(BootstrapCode::Protocol, "The server did not report its platform."))?;
        Ok((value, platform))
    }

    /// `args` run on the server with the runtime uploaded: its digests and bundle go with the run.
    async fn run_uploading(
        self,
        payloads: &dyn ServerPayloads,
        platform: ServerPlatform,
        args: &ProgramArgs,
        timeout: Duration,
    ) -> Result<Map<String, Value>, ConnectError> {
        let binary = payloads.binary(platform)?;
        let mut with_upload = args.clone();
        with_upload.upload = true;
        with_upload.sha256 = Some(binary.sha256);
        with_upload.bundle_sha256 = Some(binary.bundle_sha256);
        Ok(self.run(&with_upload, timeout.max(REMOTE_INSTALL_TIMEOUT), Some(binary.archive)).await?.0)
    }

    /// `args` run on the server: with the runtime uploaded when this build is not installed, and once more with it
    /// when another desktop's cleanup removed the build between the probe and now.
    pub(crate) async fn run_with_install(
        self,
        payloads: &dyn ServerPayloads,
        platform: ServerPlatform,
        args: &ProgramArgs,
        installed: bool,
        timeout: Duration,
    ) -> Result<Map<String, Value>, ConnectError> {
        if !installed {
            return self.run_uploading(payloads, platform, args, timeout).await;
        }
        match self.run(args, timeout, None).await {
            Err(ConnectError::Bootstrap(error)) if error.code == BootstrapCode::InstallMissing.as_str() => {
                self.run_uploading(payloads, platform, args, timeout).await
            }
            other => Ok(other?.0),
        }
    }
}

/// The arguments every run of this desktop's build starts from.
pub(crate) fn base_args(identity: &ServerIdentity, mode: Mode) -> ProgramArgs {
    let mut args = ProgramArgs::new(mode, &identity.version, &identity.build);
    args.lock_wait_ms = Some(REMOTE_INSTALL_LOCK_WAIT_MS);
    args.lock_stale_ms = Some(REMOTE_INSTALL_LOCK_STALE_MS);
    args
}

// ---------------------------------------------------------------------------------------------
// The bootstrap
// ---------------------------------------------------------------------------------------------

/// Where a bootstrap is: the dialog's `check`, then `install` (the runtime is uploaded) or `start`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootstrapPhase {
    /// The probe answered: `detail` is the server's platform (`linux-x64`).
    Check { detail: String },
    Install,
    Start,
}

pub struct BootstrapOptions<'a> {
    /// Whose provider logins the core runs models on; `None` is this PC's.
    pub model_login: Option<ModelLogin>,
    /// Where the runtime to upload comes from.
    pub payloads: &'a dyn ServerPayloads,
    pub progress: &'a (dyn Fn(BootstrapPhase) + Sync),
}

fn ready(report: RemoteReport) -> Result<RemoteReport, ConnectError> {
    if report.healthy && report.core_current && report.serving().is_some() {
        return Ok(report);
    }
    Err(RemoteBootstrapError::from_wire(DAEMON_UNHEALTHY, "The Mixdog core on the server is not serving.", None).into())
}

/// Probes the server, uploads this desktop's runtime when its version directory is missing, and makes sure the core
/// there serves this desktop's version. `context.force_restart` is the user's confirmation of the last
/// `daemon-busy-other-version` listing. The returned discovery (and its token) only lives in memory.
pub async fn bootstrap(
    env: &SshEnv,
    context: &AttemptContext,
    target: &SshTarget,
    options: BootstrapOptions<'_>,
) -> Result<RemoteReport, ConnectError> {
    let remote = Remote { env, context, target };
    let identity = options.payloads.identity();
    let mut base = base_args(identity, Mode::Probe);
    // Only the opt-in travels: a server on this PC's logins gets exactly the arguments it always did.
    if options.model_login == Some(ModelLogin::Server) {
        base.model_login = Some(WireModelLogin::Server);
    }
    let (probed, platform) = remote.run(&base, REMOTE_PROBE_TIMEOUT, None).await?;
    let probe = report_of(&probed);
    (options.progress)(BootstrapPhase::Check { detail: platform.key() });
    if probe.installed && probe.core_current {
        return ready(probe);
    }

    let key = target.display.clone();
    let listed = PENDING_DRAINS.lock().unwrap_or_else(PoisonError::into_inner).remove(&key);
    let confirm_token = listed.filter(|_| context.force_restart).map(|drain| drain.confirm_token);
    (options.progress)(if probe.installed { BootstrapPhase::Start } else { BootstrapPhase::Install });
    let mut ensure = base;
    ensure.mode = Mode::Ensure;
    ensure.confirm_token = confirm_token;
    let ensured = match remote.run_with_install(options.payloads, platform, &ensure, probe.installed, REMOTE_ENSURE_TIMEOUT).await {
        Ok(ensured) => ensured,
        Err(error) => {
            if let ConnectError::Bootstrap(RemoteBootstrapError { detail: Some(drain), .. }) = &error {
                PENDING_DRAINS.lock().unwrap_or_else(PoisonError::into_inner).insert(key, drain.clone());
            }
            return Err(error);
        }
    };
    ready(report_of(&ensured))
}
