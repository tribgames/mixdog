//! Plain data of the core state machine: reasons, activities, status views, effects.

use mixdog_protocol::DrainReason;
use serde::Deserialize;
use serde::Serialize;

pub use mixdog_app_protocol::mgmt::ActivityKind;
pub use mixdog_app_protocol::mgmt::Blocked;
pub use mixdog_app_protocol::mgmt::BlockedStatus;
pub use mixdog_app_protocol::mgmt::CoreStatus;
pub use mixdog_app_protocol::mgmt::DrainStatus;
pub use mixdog_app_protocol::mgmt::FenceReason;
pub use mixdog_app_protocol::mgmt::MigrationStatus;
pub use mixdog_app_protocol::mgmt::RunningWork;
pub use mixdog_app_protocol::mgmt::StateName;
pub use mixdog_app_protocol::mgmt::StopMode;
pub use mixdog_app_protocol::mgmt::StopReason;

/// What the registrant tells the core about a unit of work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityInfo {
    pub kind: ActivityKind,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub title: String,
}

/// One registered unit of work, as listed to the user in a drain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    #[serde(skip)]
    pub id: u64,
    pub kind: ActivityKind,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Migration {
    pub kind: String,
    pub done: u64,
    pub total: u64,
}

impl From<&Running> for RunningWork {
    fn from(running: &Running) -> Self {
        Self {
            kind: running.kind,
            thread_id: running.thread_id.clone(),
            turn_id: running.turn_id.clone(),
            title: running.title.clone(),
        }
    }
}

/// Management command refusals. Each is a fact about the state, not a transient condition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CommandError {
    #[error("the confirmation token does not match what is running")]
    ConfirmationInvalid,
    #[error("no drain is in progress")]
    NotDraining,
    #[error("the drain id is not the current drain")]
    DrainMismatch,
    #[error("the drain is past its idle wait")]
    PastIdleWait,
    #[error("a migration is running; a stop waits until it has finished")]
    Migrating,
    #[error("the core is not blocked on a decision")]
    NotBlocked,
    #[error("the core is winding down")]
    WindingDown,
    #[error("the core has stopped")]
    Stopped,
    #[error("the core is not in the boot phase this step belongs to")]
    BadPhase,
}

impl CommandError {
    pub fn code(self) -> &'static str {
        match self {
            CommandError::ConfirmationInvalid => "confirmationInvalid",
            CommandError::NotDraining => "notDraining",
            CommandError::DrainMismatch => "drainMismatch",
            CommandError::PastIdleWait => "pastIdleWait",
            CommandError::Migrating => "migrating",
            CommandError::NotBlocked => "notBlocked",
            CommandError::WindingDown => "windingDown",
            CommandError::Stopped => "stopped",
            CommandError::BadPhase => "badPhase",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiscoveryPhase {
    Booting,
    Blocked,
    Migrating,
    Serving,
    Draining,
}

/// What the lifecycle contributes to the discovery file (LR §4): the rest of the document is
/// the owner of discovery's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryState {
    pub phase: DiscoveryPhase,
    pub blocked: Option<Blocked>,
    pub drain_id: Option<String>,
}

/// The app-feed `core/drain` payload (LR §5.1 step 2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainNotice {
    pub drain_id: String,
    pub reason: DrainReason,
    pub running: Vec<Running>,
    pub confirm_token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseCause {
    Stop(StopReason),
    Fenced(FenceReason),
}

impl ReleaseCause {
    /// The `reason` recorded in `last-exit.json`.
    pub fn text(self) -> String {
        let value = match self {
            ReleaseCause::Stop(reason) => serde_json::to_value(reason),
            ReleaseCause::Fenced(reason) => serde_json::to_value(reason),
        };
        match value {
            Ok(serde_json::Value::String(text)) => text,
            _ => unreachable!("unit enum variants serialize to strings"),
        }
    }

    /// The reason Node's `shutdown(reason)` carries (`daemon.mjs:272`), which `sessionRuntimeHost.close(reason)` (`:316`) hands to
    /// `agent-dispatch.mjs:60` `abortAll(reason)` as the error every aborted run fails with. A signal's name (`SIGTERM`, `SIGINT`,
    /// `SIGHUP`, `SIGBREAK`, `:1298-1308`) is noted by the trigger itself (`Lifecycle::note_trigger`); these are the texts of the causes
    /// that have a Node counterpart. Rust's single `NoClients` trigger is Node's self-shutdown of `maybeSelfShutdown` (`:506`), whose
    /// reasons are 'no live session clients' (`:1245`), 'no live channel clients' (`:917`), 'remote clients changed' (`:1159`),
    /// 'memory agent activity changed' (`:1065`) and the rechecks 'service calls settled' (`:543`) and 'busy service work settled' (`:556`);
    /// it fires when the last client is gone, which is `:1245`. A replacement (`:589`) reads `daemon replacement by revision/build <rev>/<ver>`;
    /// the stop request carries neither number, so the text stops at 'daemon replacement'. A user's stop or quit is the parent's IPC
    /// message (`:1311`, 'IPC shutdown'). A lost owner lock is `fenceDaemon` (`:655`, 'owner lock file <path> was deleted or replaced';
    /// the path is not part of the fence), and the other fences have no Node counterpart: they keep their own name.
    pub fn node_text(self) -> String {
        match self {
            ReleaseCause::Stop(StopReason::NoClients) => "no live session clients".to_owned(),
            ReleaseCause::Stop(StopReason::Update | StopReason::Restart | StopReason::FastDeploy | StopReason::SshReplace) => "daemon replacement".to_owned(),
            ReleaseCause::Stop(StopReason::Quit | StopReason::UserStop) => "IPC shutdown".to_owned(),
            ReleaseCause::Fenced(FenceReason::LockFileReplaced) => "owner lock file was deleted or replaced".to_owned(),
            ReleaseCause::Fenced(_) => self.text(),
        }
    }
}

/// Something the machine decided that happens outside it, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Discovery(DiscoveryState),
    DrainNotice(DrainNotice),
    CancelRunning(Vec<Running>),
    ReleaseDecision { pid: u32 },
    BeginRelease(ReleaseCause),
}
