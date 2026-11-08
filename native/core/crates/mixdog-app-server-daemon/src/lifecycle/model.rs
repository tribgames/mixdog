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
    /// The discovery file could not be published: Node's `main().catch` -> `shutdown('fatal boot error', 2)`.
    FatalBoot,
}

impl ReleaseCause {
    /// The process exit code: Node's `shutdown(reason, code)` code.
    pub fn exit_code(self) -> i32 {
        match self {
            ReleaseCause::FatalBoot => 2,
            ReleaseCause::Stop(_) | ReleaseCause::Fenced(_) => 0,
        }
    }

    /// The `reason` recorded in `last-exit.json`.
    pub fn text(self) -> String {
        let value = match self {
            ReleaseCause::FatalBoot => return "fatalBoot".to_owned(),
            ReleaseCause::Stop(reason) => serde_json::to_value(reason),
            ReleaseCause::Fenced(reason) => serde_json::to_value(reason),
        };
        match value {
            Ok(serde_json::Value::String(text)) => text,
            _ => unreachable!("unit enum variants serialize to strings"),
        }
    }

    /// The reason Node's `shutdown(reason)` carries (`daemon.mjs:272`), which `sessionRuntimeHost.close(reason)` (`:316`) hands to
    /// `agent-dispatch.mjs:60` `abortAll(reason)` as the error every aborted run fails with, for the causes whose text is fixed.
    /// The texts that carry a fact are noted by the trigger that knows it (`Lifecycle::note_trigger`) and win over this one:
    /// a signal's name (`SIGTERM`, `SIGINT`, `SIGHUP`, `SIGBREAK`, `:1298-1308`); the self-shutdown texts of `NoClients` (`ClientKind`,
    /// the machine's `NodeTrigger`: `:1245`, `:917`, `:1159`, `:556`); a replacement's `daemon replacement by revision/build <rev>/<ver>`
    /// (`:589`, from the stop request's build); the lost owner lock's `owner lock file <path> was deleted or replaced` (`:655`,
    /// `Lifecycle::fence_at`).
    ///
    /// `Quit` and `UserStop` are the requests to stop an idle core that a client makes over the control listener (`/mgmt/stop`;
    /// an OS signal notes its own name, which wins). Node's request of that kind is `POST /shutdown` (`session-client.mjs`
    /// `shutdownDaemon`, what the harness, the dev teardown and the headless CLI send): `session-transport/routes.mjs:189-196`
    /// answers it and calls `onClientsEmpty()`, which is `maybeSelfShutdown('no live session clients')` (`daemon.mjs:1245`), so the
    /// stop is recorded with that text (the `detachedReason` of the sessions it detaches). The parent's IPC message (`:1311`,
    /// `child.send({ type: 'shutdown' })`) is a different event, which only a desktop that parents the daemon sends; the core has no such parent.
    /// A `Quit` request that had to wait for running work is the recheck of that deferral, which reads what settled last
    /// (`service calls settled` / `busy service work settled`, `daemon.mjs:530-560`): the machine notes it as a trigger (see `settle`).
    /// The other fences have no Node counterpart: they keep their own name, as do the carrying causes when no fact was noted.
    pub fn node_text(self) -> String {
        match self {
            ReleaseCause::Stop(StopReason::Quit | StopReason::UserStop) => ClientKind::Session.node_text().to_owned(),
            ReleaseCause::FatalBoot => "fatal boot error".to_owned(),
            _ => self.text(),
        }
    }
}

/// What kind of client connection closed: the three registries Node's `maybeSelfShutdown` is called from when one empties.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientKind {
    /// The session transport's clients (`onClientsEmpty`, `daemon.mjs:1245`): 'no live session clients'.
    Session,
    /// The channels runtime's clients (`daemon.mjs:917`): 'no live channel clients'.
    Channel,
    /// The remote (phone / SSH) clients (`onExternalClientsChanged`, `daemon.mjs:1159`): 'remote clients changed'.
    Remote,
}

impl ClientKind {
    pub const fn node_text(self) -> &'static str {
        match self {
            ClientKind::Session => "no live session clients",
            ClientKind::Channel => "no live channel clients",
            ClientKind::Remote => "remote clients changed",
        }
    }
}

/// Node's recheck text when the busy work of a deferred self-shutdown has settled (`daemon.mjs:556`, `busySessions` / `busyMemoryAgents`).
pub const BUSY_WORK_SETTLED: &str = "busy service work settled";
/// The recheck when the in-flight service calls have settled (`daemon.mjs:543`, `activeCalls` / `queuedCalls`): the text of the last
/// call ending (`Lifecycle::begin_call`; a call is no listed work, so it is counted apart from the activities).
pub const SERVICE_CALLS_SETTLED: &str = "service calls settled";
/// The memory agents' own callback (`daemon.mjs:1065`, `onActivityChanged`): the text of a memory-agent activity.
pub const MEMORY_AGENT_ACTIVITY_CHANGED: &str = "memory agent activity changed";

/// Something the machine decided that happens outside it, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Discovery(DiscoveryState),
    DrainNotice(DrainNotice),
    CancelRunning(Vec<Running>),
    ReleaseDecision { pid: u32 },
    /// Node's text of the self-shutdown that is about to begin (`Lifecycle::note_trigger`), before its `BeginRelease`.
    NodeTrigger(&'static str),
    BeginRelease(ReleaseCause),
}
