//! Saved SSH servers, the link between a server window and its daemon, the Ports panel, the "connect
//! to another PC" hosts, and the host channel's window requests.
//!
//! Every type is a field-for-field mirror of the desktop contract it replaces: `shared/contract-ssh.ts`,
//! `contract-connection-link.ts`, `contract-server-ports.ts` and `DesktopRemoteHost` (`contract-workspace.ts`), with the
//! `Desktop` prefix dropped. A TypeScript union keeps its member shapes on the wire; a field the contract types `T | null`
//! is always written, one it types `field?: T` is left out when absent.

use mixdog_protocol::SubscriptionId;
use serde::Deserialize;
use serde::Serialize;

// ---- saved servers (contract-ssh.ts)

/// Where an ssh attempt is: reaching the server, checking it, installing, starting its daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SshPhase {
    Connect,
    Check,
    Install,
    Start,
    Ready,
}

/// Whose provider logins a server's models run on: this PC's (the default) or the server's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SshModelLogin {
    Pc,
    Server,
}

/// What a saved server remembers besides its name and address.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshHostSettings {
    /// `server`: the server's daemon runs models with the logins stored on the server; absent or `pc`: with this PC's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_login: Option<SshModelLogin>,
    /// Server folder the session opens in: `~`, `~/x` or an absolute server path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_cwd: Option<String>,
    /// Private key file on this PC (passed to ssh with `-i`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    /// Re-dial the tunnel when it drops; on unless `false`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_reconnect: Option<bool>,
    /// Model providers this server may use through this PC; `null` or absent: every provider enabled on this PC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "Array<string> | null"))]
    pub allowed_providers: Option<Vec<String>>,
    /// Minutes the server keeps its work after the connection drops (1-10080, default 30).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grace_minutes: Option<u32>,
}

/// A saved SSH server. `open` is true while its server window is open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshHost {
    pub id: String,
    pub name: String,
    /// `alias`, `host`, `user@host` or `user@host:port`.
    pub target: String,
    /// Epoch ms; always written, `null` before the first connection.
    #[cfg_attr(feature = "codegen", ts(optional = false, type = "number | null"))]
    pub last_connected_at: Option<i64>,
    pub open: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<SshHostSettings>,
}

/// A `Host` alias of this PC's `~/.ssh/config`; `detail` is `user@host[:port]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub alias: String,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SshHopRole {
    Jump,
    Target,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SshHopStatus {
    Trusted,
    Unknown,
    Changed,
    Revoked,
    Unreadable,
    /// Not read yet: it is only reachable through a hop that is not trusted yet.
    Pending,
}

/// One server on the way to the target (a ProxyJump hop, then the target itself).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshHopKey {
    pub name: String,
    pub role: SshHopRole,
    pub status: SshHopStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_type: Option<String>,
}

/// What `ssh -G` resolves the address to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshConfigSummary {
    pub host_name: String,
    #[cfg_attr(feature = "codegen", ts(optional = false, type = "string | null"))]
    pub user: Option<String>,
    pub port: u16,
    #[cfg_attr(feature = "codegen", ts(optional = false, type = "string | null"))]
    pub proxy_jump: Option<String>,
    /// A ProxyCommand is configured (its text is not shown).
    pub proxy_command: bool,
    /// Only when Mixdog could not set them aside: the Local/Remote/DynamicForward lines of the user's ssh config that apply while connected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forwards: Option<Vec<String>>,
}

/// Where ssh was not found, and the command that installs it when there is one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshMissing {
    pub command: Option<String>,
}

/// What the server's key looks like against this PC's known_hosts. `hops` is set when the connection goes through
/// a jump host: every key on the way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SshHostKeyCheck {
    #[serde(rename_all = "camelCase")]
    Trusted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        authority: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        hops: Option<Vec<SshHopKey>>,
    },
    #[serde(rename_all = "camelCase")]
    Unknown {
        fingerprint: String,
        key_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        hops: Option<Vec<SshHopKey>>,
    },
    #[serde(rename_all = "camelCase")]
    Changed {
        previous: String,
        current: String,
        key_type: String,
        /// The name to type to confirm replacing the key.
        host: String,
        /// The exact command that forgets the old key.
        remove_command: String,
        /// The old key is in Mixdog's own known_hosts, so Mixdog may replace it; `false`: only the command above does.
        replaceable: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        hops: Option<Vec<SshHopKey>>,
    },
    #[serde(rename_all = "camelCase")]
    Revoked { fingerprint: String, host: String },
    #[serde(rename_all = "camelCase")]
    Unreachable {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        ssh_missing: Option<SshMissing>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SshAgentState {
    Running,
    Empty,
    Stopped,
    Disabled,
    Missing,
    Unknown,
}

/// State of the ssh-agent on this PC, for the login guidance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshAgentStatus {
    pub state: SshAgentState,
    /// Commands that bring the agent up and load a key, when there is something to run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

/// Why the server's Node is unusable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum SshNodeProblem {
    Missing,
    TooOld,
}

/// Why a connection stopped; each kind has its own guidance view. The kinds the contract shares one shape between
/// (`daemon-stop | daemon-replace | daemon-unproven`, `daemon-unmanaged | daemon-data-in-use`) are one variant each.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SshFailureKind {
    HostKeyChanged {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        previous: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        current: Option<String>,
    },
    HostKeyRevoked,
    /// The key shown was saved, and a server further along the jump chain now needs its own check.
    HostKeyNext,
    Auth {
        keygen: String,
        register: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        agent: Option<SshAgentStatus>,
    },
    SshMissing { command: Option<String> },
    UnsupportedPlatform { message: String },
    InstallFailed { message: String },
    InstallLocked,
    /// The server's Mixdog speaks another protocol version: reconnecting reinstalls the matching one.
    ProtocolMismatch { message: String },
    /// An unexpected error inside Mixdog (bootstrap/protocol), not something the user's server setup caused.
    Internal { message: String },
    /// The login shell or home directory of the server answered in a way the bootstrap cannot use.
    RemoteShell { message: String },
    DaemonBusy { message: String },
    PortUnavailable { message: String },
    Cancelled,
    /// The server is connected already, so a new login key or folder cannot be tested: disconnecting first is the only way.
    AlreadyConnected,
    Node { reason: SshNodeProblem, found: Option<String>, required: u32, command: String },
    NpmMissing { command: String },
    DepsInstall { message: String },
    DaemonStop { message: String },
    DaemonReplace { message: String },
    DaemonUnproven { message: String },
    /// The server's own (non-desktop) Mixdog is in the way: it is left running and there is nothing to restart.
    DaemonUnmanaged { message: String },
    /// Another daemon holds the data folder.
    DaemonDataInUse { message: String },
    DaemonRunning { pid: u32 },
    Failed { message: String },
}

/// A failure with the code behind its view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshFailure {
    #[serde(flatten)]
    pub kind: SshFailureKind,
    /// The error code behind the view (a bootstrap code such as `install-failed`, or the view's own name); shown in the details line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// `{ ok: true, host }` of a connect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshConnectOk {
    #[cfg_attr(feature = "codegen", ts(type = "true"))]
    pub ok: bool,
    pub host: SshHost,
}

/// `{ ok: false, failure }` of a connect or a cleanup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshFailed {
    #[cfg_attr(feature = "codegen", ts(type = "false"))]
    pub ok: bool,
    pub failure: SshFailure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(untagged)]
pub enum SshConnectResult {
    Connected(SshConnectOk),
    Failed(SshFailed),
}

impl SshConnectResult {
    pub fn connected(host: SshHost) -> Self {
        Self::Connected(SshConnectOk { ok: true, host })
    }

    pub fn failed(failure: SshFailure) -> Self {
        Self::Failed(SshFailed { ok: false, failure })
    }
}

/// The host-key pre-check of one address. `attemptId` is minted by the core and bound to the asking connection: connecting,
/// cancelling and stopping a daemon all name it, and the core connects only to the address and key it inspected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshInspection {
    pub attempt_id: String,
    pub check: SshHostKeyCheck,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<SshConfigSummary>,
}

/// The settings a connect dialog's advanced options carry (`Pick<SshHostSettings, 'identityFile' | 'remoteCwd'>`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshConnectSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshConnectRequest {
    /// From `connections/ssh/inspect`; also pairs the progress notifications with this call.
    pub attempt_id: String,
    /// The user confirmed the fingerprint the inspection reported: save that key first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_host_key: Option<bool>,
    /// Replace the changed key: the server name typed to confirm (must equal the name `check.host` showed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_host_key: Option<String>,
    /// The user accepted the forwards listed in the inspection summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept_forwards: Option<bool>,
    /// Entered in the connect dialog's advanced options: used for this attempt and saved with the server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<SshConnectSettings>,
    /// Stop whatever daemon runs on the server and start this app's (after the user confirmed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force_restart: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SshAskpassKind {
    Passphrase,
    Password,
    Otp,
    Other,
    /// Withdraws the question.
    Close,
}

/// A question from ssh (passphrase, password, one-time code) for the user; `close` withdraws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshAskpass {
    /// The connect attempt or cleanup the question belongs to.
    pub attempt_id: String,
    pub request_id: String,
    pub kind: SshAskpassKind,
    /// The server the question comes from, shown above text the server supplied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// The prompt exactly as ssh printed it.
    pub prompt: String,
    /// The previous answer was refused.
    pub retry: bool,
    pub timeout_ms: u32,
}

/// The connection log of one server (ring buffer, secrets removed). `copyText` is the same text with the server's user and
/// host replaced by `<server>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshLogView {
    pub lines: Vec<String>,
    pub copy_text: String,
}

/// The text to copy for a bug report (`connections/ssh/diagnosticsCopy`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshDiagnosticsText {
    pub text: String,
}

/// `{ ok: true, text, copyText }` of a server log read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshServerLogText {
    #[cfg_attr(feature = "codegen", ts(type = "true"))]
    pub ok: bool,
    pub text: String,
    pub copy_text: String,
}

/// `{ ok: false, message }` of a server log read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshServerLogFailed {
    #[cfg_attr(feature = "codegen", ts(type = "false"))]
    pub ok: bool,
    pub message: String,
}

/// The tail of the server's `daemon.log`, fetched over ssh.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(untagged)]
pub enum SshServerLog {
    Text(SshServerLogText),
    Failed(SshServerLogFailed),
}

impl SshServerLog {
    pub fn text(text: String, copy_text: String) -> Self {
        Self::Text(SshServerLogText { ok: true, text, copy_text })
    }

    pub fn failed(message: String) -> Self {
        Self::Failed(SshServerLogFailed { ok: false, message })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshCleanupRequest {
    /// The window's own id for this run; its questions arrive with it as `attemptId`.
    pub operation_id: String,
    /// Also delete the server's work history.
    pub remove_user_data: bool,
    /// Forget the saved entry afterwards.
    pub forget: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SshCleanupPhase {
    Connect,
    Stop,
    Remove,
    Done,
}

/// Where a server cleanup is: reaching the server, stopping its daemon, removing the files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshCleanupProgress {
    pub operation_id: String,
    pub phase: SshCleanupPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// `{ ok: true, hosts, detail? }` of a cleanup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshCleanupDone {
    #[cfg_attr(feature = "codegen", ts(type = "true"))]
    pub ok: bool,
    pub hosts: Vec<SshHost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(untagged)]
pub enum SshCleanupResult {
    Done(SshCleanupDone),
    Failed(SshFailed),
}

impl SshCleanupResult {
    pub fn done(hosts: Vec<SshHost>, detail: Option<String>) -> Self {
        Self::Done(SshCleanupDone { ok: true, hosts, detail })
    }

    pub fn failed(failure: SshFailure) -> Self {
        Self::Failed(SshFailed { ok: false, failure })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshProgress {
    pub attempt_id: String,
    pub phase: SshPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub detail: Option<String>,
}

/// Where an API key's effective value comes from on the server: its OS keychain, its private secrets file (no keychain
/// provider), or an environment variable (which wins over both).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum SshCredentialSource {
    Keychain,
    PrivateFile,
    Environment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SshServerLoginKind {
    /// A subscription login.
    Oauth,
    /// An API key.
    Api,
}

/// One provider login stored on a server (its daemon's own config).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshServerLogin {
    pub id: String,
    pub name: String,
    pub kind: SshServerLoginKind,
    pub signed_in: bool,
    /// An API key's effective source on the server, when it reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_source: Option<SshCredentialSource>,
    /// The key comes from the server's environment: it cannot be changed or removed here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_environment: Option<bool>,
    /// The key is kept in the server's private secrets file (the server has no OS keychain).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stored_in_private_file: Option<bool>,
    /// A custom provider of the server's own (an `api` row): its key is saved and the provider removed through the
    /// custom-provider operations, not the built-in key ones.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<bool>,
    /// A custom provider that needs no key at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyless: Option<bool>,
    /// A signed-in subscription's account as the server knows it (its email).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
}

/// Why the server's stored keys cannot be read (its keyring is locked, or its private secrets store is unsafe): the sanitized
/// issue the server's setup reports. Never holds a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshKeychainIssue {
    pub state: String,
    /// For an unsafe private store: `permissions`, `owner` or `type`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The server's fixed, translatable hint.
    pub message: String,
    /// The server's secrets folder to repair.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// The server's logins as the settings dialog shows them. `connected`: the server's window is attached; `modelLogin`: the
/// mode its daemon runs in now; `providers` only when it runs with the server's own logins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshServerLogins {
    pub connected: bool,
    #[cfg_attr(feature = "codegen", ts(optional = false))]
    pub model_login: Option<SshModelLogin>,
    /// Running sessions on the server (`null` when unknown).
    #[cfg_attr(feature = "codegen", ts(optional = false, type = "number | null"))]
    pub busy_sessions: Option<u32>,
    #[cfg_attr(feature = "codegen", ts(optional = false))]
    pub providers: Option<Vec<SshServerLogin>>,
    /// Set when the server's credential storage needs attention.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keychain: Option<SshKeychainIssue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SshServerLoginFlowState {
    Pending,
    Complete,
    Failed,
    Cancelled,
    Expired,
}

/// A subscription login running on the server; `forwarded`: the provider's localhost callback port is forwarded from this PC
/// while it is pending.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SshServerLoginFlow {
    pub flow_id: String,
    pub provider: String,
    pub state: SshServerLoginFlowState,
    #[cfg_attr(feature = "codegen", ts(optional = false, type = "string | null"))]
    pub url: Option<String>,
    #[cfg_attr(feature = "codegen", ts(optional = false, type = "string | null"))]
    pub error: Option<String>,
    pub forwarded: bool,
    /// The device code the provider's page asks for, when the URL does not carry it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    /// Whether a pasted address or code can complete the login (absent: unknown, offered).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_code_supported: Option<bool>,
    /// Set by `connections/ssh/serverLoginBegin`: the address the renderer opens with the existing `openExternal` call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_url: Option<String>,
}

// ---- the link of a server window to its daemon (contract-connection-link.ts)

/// What the window shows while the tunnel is up, recovering, lost or paused for sleep.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ConnectionLinkState {
    Connected,
    #[serde(rename_all = "camelCase")]
    Reconnecting {
        attempt: u32,
        /// Epoch ms; `null` while an attempt is running.
        #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
        next_retry_at: Option<i64>,
    },
    /// `terminal`: only a new connection can fix it (host key, login, server install). `settingsRequired`: it needs the
    /// user's confirmation, which only Settings -> Connection in this PC's window can give.
    #[serde(rename_all = "camelCase")]
    Lost {
        terminal: bool,
        code: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        settings_required: Option<bool>,
    },
    /// This PC is asleep: not a failure.
    Paused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLinkView {
    pub connection_id: String,
    pub state: ConnectionLinkState,
    /// Last health round trip through the tunnel in ms; `null` before the first.
    pub rtt_ms: Option<u32>,
    /// `false` when the server cannot run terminals; everything else still works.
    pub terminals_available: bool,
    /// Whose provider logins the server's models run on: `server` shows the "Server account" badge beside the model name.
    pub model_login: SshModelLogin,
}

/// What the core tells a server window once it is attached again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ConnectionNotice {
    /// The window is attached again. Session titles whose turn finished or kept running on the server meanwhile, and model
    /// calls that broke off.
    #[serde(rename_all = "camelCase")]
    Reattached { finished: Vec<String>, continued: Vec<String>, interrupted_model_calls: u32 },
    /// Tool calls whose result never arrived; they are not run again.
    #[serde(rename_all = "camelCase")]
    OutcomeUnknown { session_id: String, tool_ids: Vec<String> },
    /// This PC's model sign-in was refused during the server's turn.
    #[serde(rename_all = "camelCase")]
    ModelSignIn { provider: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ServerRestorePhase {
    Connect,
    Check,
    Install,
    Start,
    Ready,
    Failed,
}

/// Startup reopening of the server windows open at the last quit, shown in this PC's window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ServerRestoreProgress {
    pub id: String,
    pub name: String,
    pub phase: ServerRestorePhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

// ---- the Ports panel of a server window (contract-server-ports.ts)

/// One port something listens on, on the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ServerPort {
    pub port: u16,
    /// Where it listens: `0.0.0.0`, `127.0.0.1`, `::`, `::1` (several, joined).
    pub addresses: Vec<String>,
    /// The owning process, when the server lets the daemon read it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum PortForwardStatus {
    Starting,
    Active,
    Error,
}

/// A server port forwarded to `127.0.0.1:<localPort>` on this PC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct PortForward {
    pub remote_port: u16,
    /// 0 until the first local port is chosen.
    pub local_port: u16,
    pub status: PortForwardStatus,
    /// Why it stopped, for `error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ServerPortsView {
    /// `null`: the last scan failed (see `scanError`) or none ran yet.
    #[cfg_attr(feature = "codegen", ts(optional = false))]
    pub detected: Option<Vec<ServerPort>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scan_error: Option<String>,
    pub forwards: Vec<PortForward>,
    /// Ports that started listening after the panel first looked: offered for forwarding, never forwarded on their own.
    pub suggested: Vec<u16>,
}

// ---- "connect to another PC" hosts (DesktopRemoteHost)

/// A saved "Connect to another PC" host on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct RemoteHost {
    pub id: String,
    pub name: String,
    /// The host's pairing link: the relay origin plus its device route.
    pub url: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub added_at: i64,
    #[cfg_attr(feature = "codegen", ts(optional = false, type = "number | null"))]
    pub last_connected_at: Option<i64>,
    /// Whether its window is open right now (the core answers `false`; the desktop fills it).
    pub open: bool,
    /// Whether the host's desktop is connected to its relay right now. Absent when the relay could not be asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub online: Option<bool>,
}

// ---- params and results of the connections/* and remoteHosts/* methods

/// Params of a method that takes nothing.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsNoParams {}

/// `connections/subscribe`: with `connectionId` only `link/<id>` and `ports/<id>` are delivered.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ConnectionsSubscribeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsUnsubscribeParams {
    pub subscription_id: SubscriptionId,
}

/// A saved server or a saved remote PC by its id (`ssh/forget`, `ssh/open`, `ssh/serverLogins`, `remoteHosts/forget`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsIdParams {
    pub id: String,
}

/// A connection (`local` or a saved server's id): `link/get`, `link/retry`, `link/retryNow`, `link/requestSignIn`,
/// `ports/list`, `endpoint`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionIdParams {
    pub connection_id: String,
}

/// `connections/ssh/rename`, `remoteHosts/rename`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsRenameParams {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshInspectParams {
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshConnectParams {
    pub attempt_id: String,
    pub request: SshConnectRequest,
}

/// `connections/ssh/cancel`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshCancelParams {
    pub attempt_id: String,
}

/// `connections/ssh/askpassReply`; `secret: null` cancels the question. At most 4096 characters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshAskpassReplyParams {
    pub attempt_id: String,
    pub request_id: String,
    pub secret: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshCleanupParams {
    pub id: String,
    pub request: SshCleanupRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshUpdateSettingsParams {
    pub id: String,
    pub settings: SshHostSettings,
}

/// `connections/ssh/diagnosticsLog`, `diagnosticsCopy`, `serverLog`: `ref` is a saved server's id or an address; a server
/// window always gets its own server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshDiagnosticsRefParams {
    #[serde(rename = "ref")]
    #[cfg_attr(feature = "codegen", ts(rename = "ref"))]
    pub reference: String,
}

/// `connections/ssh/serverLoginBegin`, `serverLoginLogout`, `serverLoginRemoveCustom`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshServerLoginProviderParams {
    pub id: String,
    pub provider: String,
}

/// `connections/ssh/serverLoginStatus`, `serverLoginCancel`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshServerLoginFlowParams {
    pub id: String,
    pub flow_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshServerLoginCompleteParams {
    pub id: String,
    pub flow_id: String,
    pub redirect_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshServerLoginSaveKeyParams {
    pub id: String,
    pub provider: String,
    pub key: String,
}

/// `connections/ports/forward`; `localPort: null` picks the same number when free.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PortsForwardParams {
    pub connection_id: String,
    pub remote_port: u16,
    pub local_port: Option<u16>,
}

/// `connections/ports/stop`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PortsStopParams {
    pub connection_id: String,
    pub remote_port: u16,
}

/// `connections/ports/dismiss`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PortsDismissParams {
    pub connection_id: String,
    pub port: u16,
}

/// `connections/restore/get` result and `connections/restore/set` params: "Reopen server windows when the app starts".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsRestoreState {
    pub enabled: bool,
}

/// `connections/endpoint`: where a server window's relay dials the tunnel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEndpoint {
    pub url: String,
    pub token: String,
    pub server_instance_id: String,
}

/// `connections/ssh/openEphemeral`: a dev window for `MIXDOG_SSH_TARGET`, not remembered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshOpenEphemeralParams {
    pub target: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostRedeemParams {
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostPresenceParams {
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostPresenceResult {
    pub online: Vec<String>,
}

// ---- connection-scoped notifications, core to client

/// `connections/ssh/cleanupProgress`: the progress with the saved server it is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshCleanupProgressParams {
    pub id: String,
    #[serde(flatten)]
    pub progress: SshCleanupProgress,
}

/// `connections/ssh/serverLoginUpdated`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshServerLoginUpdatedParams {
    pub id: String,
    pub flow: SshServerLoginFlow,
}

/// `connections/notice`: to every subscriber of that connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsNoticeParams {
    pub connection_id: String,
    pub notice: ConnectionNotice,
}

/// `connections/signIn`, to this PC's window: a server window needs the user's connect attempt (sign in again, or confirm a
/// changed host key).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsSignInParams {
    pub id: String,
    pub name: String,
    pub target: String,
}

// ---- the host channel's window requests (core to Electron main)

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum HostWindowKind {
    Ssh,
}

/// `host/window/open`: opens (or focuses) the window of a server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostWindowOpenParams {
    pub connection_id: String,
    pub kind: HostWindowKind,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostWindowOpenResult {
    pub opened: bool,
}

/// `host/window/close`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostWindowCloseParams {
    pub connection_id: String,
}

/// `host/window/focus`; `connectionId` `local` is the main window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostWindowFocusParams {
    pub connection_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// `host/window/closed`, host to core: a window the core asked for is gone; `byUser` unless the app is quitting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostWindowClosedParams {
    pub connection_id: String,
    pub by_user: bool,
}

/// One window of `windowFocus`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct WindowFocusEntry {
    pub connection_id: String,
    pub visible: bool,
    pub focused: bool,
    /// The session the window shows, when it shows one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// The value of `host/state/set` key `windowFocus`: every window, for the server notifier's "is it on screen" rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WindowFocusValue {
    pub windows: Vec<WindowFocusEntry>,
}

/// Where the desktop keeps what the core launches: `host/claim` `resources`. The core reads them after the environment
/// variables `MIXDOG_SERVER_CORES_DIR` and `MIXDOG_ASKPASS_HELPER`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostClaimResources {
    /// The server cores a connection installs on a server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_cores_dir: Option<String>,
    /// The `mixdog-askpass` binary ssh runs as `SSH_ASKPASS`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub askpass_helper: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round_trip<T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug>(value: serde_json::Value) {
        let typed: T = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&typed).unwrap(), value);
    }

    #[test]
    fn a_saved_server_keeps_the_contract_shape() {
        round_trip::<SshHost>(json!({"id": "a", "name": "n", "target": "u@h:22", "lastConnectedAt": null, "open": false}));
        round_trip::<SshHost>(json!({
            "id": "a", "name": "n", "target": "h", "lastConnectedAt": 5, "open": true,
            "settings": {"modelLogin": "server", "remoteCwd": "~", "identityFile": "k", "autoReconnect": false,
                "allowedProviders": ["p"], "graceMinutes": 30}
        }));
    }

    #[test]
    fn a_failure_is_its_kind_beside_its_code() {
        round_trip::<SshFailure>(json!({"kind": "host-key-changed", "previous": "a", "current": "b", "code": "x"}));
        round_trip::<SshFailure>(json!({"kind": "cancelled"}));
        round_trip::<SshFailure>(json!({"kind": "node", "reason": "too-old", "found": "v16", "required": 20, "command": "c"}));
        round_trip::<SshFailure>(json!({"kind": "daemon-data-in-use", "message": "m", "code": "daemon-data-in-use"}));
        round_trip::<SshFailure>(json!({"kind": "ssh-missing", "command": null}));
        round_trip::<SshFailure>(json!({"kind": "auth", "keygen": "k", "register": "r", "agent": {"state": "empty"}}));
    }

    #[test]
    fn a_host_key_check_is_its_status() {
        round_trip::<SshHostKeyCheck>(json!({"status": "trusted"}));
        round_trip::<SshHostKeyCheck>(json!({"status": "unknown", "fingerprint": "f", "keyType": "ed25519",
            "hops": [{"name": "j", "role": "jump", "status": "pending"}]}));
        round_trip::<SshHostKeyCheck>(json!({"status": "changed", "previous": "a", "current": "b", "keyType": "t", "host": "h",
            "removeCommand": "c", "replaceable": true}));
        round_trip::<SshHostKeyCheck>(json!({"status": "unreachable", "message": "m", "sshMissing": {"command": null}}));
    }

    #[test]
    fn a_result_is_ok_or_a_failure() {
        let host = SshHost { id: "a".into(), name: "n".into(), target: "h".into(), last_connected_at: Some(1), open: true, settings: None };
        let ok = serde_json::to_value(SshConnectResult::connected(host.clone())).unwrap();
        assert_eq!(ok["ok"], json!(true));
        assert_eq!(serde_json::from_value::<SshConnectResult>(ok).unwrap(), SshConnectResult::connected(host.clone()));
        let failed = SshConnectResult::failed(SshFailure { kind: SshFailureKind::AlreadyConnected, code: None });
        let value = serde_json::to_value(&failed).unwrap();
        assert_eq!(value, json!({"ok": false, "failure": {"kind": "already-connected"}}));
        assert_eq!(serde_json::from_value::<SshConnectResult>(value).unwrap(), failed);
        let log = serde_json::to_value(SshServerLog::text("t".into(), "c".into())).unwrap();
        assert_eq!(log, json!({"ok": true, "text": "t", "copyText": "c"}));
        let cleanup = serde_json::to_value(SshCleanupResult::done(vec![host], Some("d".into()))).unwrap();
        assert_eq!(cleanup["ok"], json!(true));
        assert_eq!(cleanup["detail"], json!("d"));
    }

    #[test]
    fn the_link_view_keeps_the_contract_shape() {
        round_trip::<ConnectionLinkView>(json!({"connectionId": "s", "state": {"status": "reconnecting", "attempt": 2, "nextRetryAt": null},
            "rttMs": null, "terminalsAvailable": true, "modelLogin": "pc"}));
        round_trip::<ConnectionLinkView>(json!({"connectionId": "s", "state": {"status": "lost", "terminal": true, "code": "c",
            "message": "m", "settingsRequired": true}, "rttMs": 12, "terminalsAvailable": false, "modelLogin": "server"}));
        round_trip::<ConnectionLinkView>(json!({"connectionId": "s", "state": {"status": "paused"}, "rttMs": 1,
            "terminalsAvailable": true, "modelLogin": "pc"}));
        round_trip::<ConnectionNotice>(json!({"kind": "reattached", "finished": ["a"], "continued": [], "interruptedModelCalls": 1}));
        round_trip::<ConnectionNotice>(json!({"kind": "outcome-unknown", "sessionId": "s", "toolIds": ["t"]}));
        round_trip::<ConnectionNotice>(json!({"kind": "model-sign-in", "provider": "p"}));
    }

    #[test]
    fn a_cleanup_progress_notification_carries_its_server_id() {
        round_trip::<SshCleanupProgressParams>(json!({"id": "s", "operationId": "o", "phase": "stop", "detail": "d"}));
    }

    #[test]
    fn the_diagnostics_ref_is_named_ref() {
        round_trip::<SshDiagnosticsRefParams>(json!({"ref": "s"}));
    }

    #[test]
    fn a_window_request_and_the_focus_value_keep_their_wire_names() {
        round_trip::<HostWindowOpenParams>(json!({"connectionId": "s", "kind": "ssh", "name": "n"}));
        round_trip::<HostWindowFocusParams>(json!({"connectionId": "local"}));
        round_trip::<HostWindowClosedParams>(json!({"connectionId": "s", "byUser": true}));
        round_trip::<WindowFocusValue>(json!({"windows": [{"connectionId": "s", "visible": true, "focused": false, "sessionId": "t"}]}));
        round_trip::<HostClaimResources>(json!({"serverCoresDir": "d", "askpassHelper": "h"}));
    }

    #[test]
    fn the_ports_view_keeps_the_contract_shape() {
        round_trip::<ServerPortsView>(json!({"detected": null, "scanError": "e", "forwards": [{"remotePort": 80, "localPort": 0,
            "status": "starting"}], "suggested": [3000]}));
        round_trip::<RemoteHost>(json!({"id": "i", "name": "n", "url": "u", "addedAt": 1, "lastConnectedAt": null, "open": false}));
    }
}
