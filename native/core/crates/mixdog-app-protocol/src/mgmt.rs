//! The management path of the core (LR §6–§7): `/mgmt/*` on the control listener. `mixdogd
//! ctl`, the desktop's SSH client and the core build and parse these same types. This is not
//! the RPC wire: it is served by the control thread, which answers while the async runtime is
//! stalled.
//!
//! Replies: `status` and every command that succeeds return [`StatusReply`]. Any non-2xx reply
//! is [`ErrorReply`].

use mixdog_protocol::DrainReason;
use serde::Deserialize;
use serde::Serialize;

pub const STATUS_PATH: &str = "/mgmt/status";
pub const HOLD_PATH: &str = "/mgmt/hold";
pub const STOP_PATH: &str = "/mgmt/stop";
pub const CANCEL_DRAIN_PATH: &str = "/mgmt/cancelDrain";
pub const RELEASE_PATH: &str = "/mgmt/release";
pub const TERMINATE_PATH: &str = "/mgmt/terminate";

/// Why a stop was asked for. The reason changes the text a user sees, and for one reason the behaviour:
/// a `whenIdle` stop for `Quit` is put off while any client is attached (Node's `POST /shutdown`, `daemon.mjs:506-529`) and the
/// core then stops when the last client leaves; every other reason drains at once and waits only for running work.
/// `NoClients` is the core's own trigger and is refused on the management path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Update,
    Quit,
    Restart,
    FastDeploy,
    SshReplace,
    UserStop,
    NoClients,
}

impl StopReason {
    /// The wire reason connected clients see in `core/drain` and `serverShuttingDown`. Clients
    /// branch on the error code and `data.reason` being present, not on which of the values
    /// it is, so the management-only reasons map to the nearest of the four.
    pub fn drain_reason(self) -> DrainReason {
        match self {
            StopReason::Update | StopReason::SshReplace => DrainReason::Update,
            StopReason::Quit | StopReason::UserStop => DrainReason::Quit,
            StopReason::Restart | StopReason::FastDeploy => DrainReason::Restart,
            StopReason::NoClients => DrainReason::NoClients,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopMode {
    /// Wait for the running work; nothing is cancelled.
    WhenIdle,
    /// Cancel the running work. Needs the `confirmToken` the drain's status shows.
    AbortConfirmed,
}

/// What a registered unit of work is. The first five make a stop wait; the last three only
/// keep an unattended core alive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ActivityKind {
    Turn,
    ApprovalWait,
    SubAgent,
    ScheduledRun,
    BackgroundShell,
    Goal,
    Schedule,
    Channel,
}

impl ActivityKind {
    pub fn blocks_idle(self) -> bool {
        matches!(
            self,
            ActivityKind::Turn
                | ActivityKind::ApprovalWait
                | ActivityKind::SubAgent
                | ActivityKind::ScheduledRun
                | ActivityKind::BackgroundShell
        )
    }
}

/// One registered unit of work, as listed to the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningWork {
    pub kind: ActivityKind,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub title: String,
}

/// A boot stopped at the prior-owner verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Blocked {
    #[serde(rename_all = "camelCase")]
    WaitExit { pid: u32 },
    #[serde(rename_all = "camelCase")]
    Undecidable { pid: u32, image: String, command_line: String, start_time: String },
}

impl Blocked {
    pub fn pid(&self) -> u32 {
        match self {
            Blocked::WaitExit { pid } | Blocked::Undecidable { pid, .. } => *pid,
        }
    }
}

/// Why the data directory can no longer be trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FenceReason {
    DataDirReplaced,
    LockFileReplaced,
    BarrierRemoved,
    LockLost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StateName {
    Booting,
    Blocked,
    Migrating,
    Serving,
    Draining,
    Stopped,
    Fenced,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedStatus {
    #[serde(flatten)]
    pub blocked: Blocked,
    /// Present for the one decision a user may take (`release`).
    pub confirm_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatus {
    pub kind: String,
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainStatus {
    pub drain_id: String,
    pub reason: StopReason,
    pub confirm_token: String,
    /// The idle wait is over and the release has begun; `cancelDrain` no longer applies.
    pub releasing: bool,
}

/// The snapshot the control thread serves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub state: StateName,
    pub version: String,
    pub instance_id: String,
    pub hold: bool,
    pub clients: usize,
    pub running: Vec<RunningWork>,
    pub blocked: Option<BlockedStatus>,
    pub migration: Option<MigrationStatus>,
    pub drain: Option<DrainStatus>,
    pub fenced: Option<FenceReason>,
    /// Confirms `terminate` for this instance only.
    pub terminate_token: String,
    pub seq_of_snapshot: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HoldRequest {
    pub on: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopRequest {
    pub mode: StopMode,
    pub reason: StopReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_token: Option<String>,
    /// The build that replaces this one; required for `update`, `restart`, `fastDeploy` and `sshReplace`, whose Node text
    /// (`daemon.mjs:589`) is `daemon replacement by revision/build <revision>/<version>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement: Option<ReplacementBuild>,
}

/// The revision and version of the build a replacement stop is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacementBuild {
    /// The replacing install's build id (`EnsureArgs.build`): the nearest thing Rust has to Node's `SESSION_REVISION`, a number
    /// Node compares for compatibility, which no Rust build carries.
    pub revision: String,
    pub version: String,
}

impl StopReason {
    /// Whether the stop is a replacement by another build (its request names the build).
    pub fn is_replacement(self) -> bool {
        matches!(self, StopReason::Update | StopReason::Restart | StopReason::FastDeploy | StopReason::SshReplace)
    }
}

impl ReplacementBuild {
    /// Node's reason text for a replacement (`daemon.mjs:589`).
    pub fn node_text(&self) -> String {
        format!("daemon replacement by revision/build {}/{}", self.revision, self.version)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelDrainRequest {
    pub drain_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseRequest {
    pub pid: u32,
    pub confirm_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminateRequest {
    pub confirm_token: String,
}

/// `status`, and the reply of every command that succeeds (the state after it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReply {
    #[serde(flatten)]
    pub status: CoreStatus,
    /// How long the async runtime has left a probe unanswered; `0` when it answers. A stalled
    /// runtime makes the other fields stale.
    pub stalled_ms: u64,
}

/// A refusal: any non-2xx reply of `/mgmt/*` has exactly this body. `code` is a state refusal
/// (409: `confirmationInvalid`, `notDraining`, `drainMismatch`, `pastIdleWait`, `migrating`,
/// `notBlocked`, `windingDown`, `stopped`, `badPhase`), `badRequest` (400), `unauthorized`
/// (401), `originRefused` (403), `unknownRoute` (404), `bodyTooLarge` (413) or `busy` (503).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorReply {
    pub code: String,
    pub message: String,
}

impl ErrorReply {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_owned(), message: message.into() }
    }
}
