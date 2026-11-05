//! The domain services of the process layer: `process`, `terminal` and `system` (ports). They
//! sit on the one [`crate::LocalProcessManager`], answer the method table's requests, and own
//! the scoped feeds `process:<handle>` (a spawned process's output; a terminal tab's output) and
//! `ports`.
//!
//! Wire shapes the method table leaves to the owner (typed `JsonValue` there):
//! - `process/spawn` result `{processHandle, pid}`; its `owner` is `"internal"`, or an object with
//!   a `kind` of `tool{threadId,toolCallId}`, `terminalTab{tabId}`, `lsp{root,lang}`,
//!   `internal`; the same kinds as a single-key object work too.
//! - `terminal/ensure` options `{profile?, cwd?, cols?, rows?}`; result `{id, replay,
//!   sizeOwner}` and `terminal/attach` result `{id, hasReplay, sizeOwner}`, where `sizeOwner` is
//!   `{cols, rows, own}` for the calling connection, or `null`.
//! - Section `terminalActivity`: `{<tabId>: "idle"|"running"|"finished"}` (an unknown state is
//!   absent). Section `terminalTabs`: `[{id, shell, running, cwd, sizeOwner:{cols,rows,owner}}]`.
//! - Section `ports` on the scoped feed `ports`: the full list `[{port, addresses, process,
//!   pid}]`, published only when a sample differs from the previous one.

mod feeds;
mod process;
mod system;
mod terminal;

pub use feeds::ProcessFeeds;
pub use process::ProcessService;
pub use system::SystemService;
pub use terminal::TerminalService;
pub use terminal::TerminalServiceConfig;

use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessQueue;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::call::Caller;
use serde::de::DeserializeOwned;

fn invalid_params(path: &str, expected: impl Into<String>) -> CoreError {
    CoreError::InvalidParams {
        path: path.into(),
        expected: expected.into().into(),
    }
}

fn decode<T: DeserializeOwned>(params: &serde_json::Value) -> Result<T, CoreError> {
    serde_json::from_value(params.clone()).map_err(|error| invalid_params("params", error.to_string()))
}

/// The id a connection owns a terminal's size and a ports view under.
fn client_of(request: &CoreRequest) -> String {
    match &request.ctx.caller {
        Caller::Connection(id) => connection_key(*id),
        Caller::Internal(name) => (*name).to_owned(),
    }
}

fn connection_key(id: ConnectionId) -> String {
    id.to_string()
}

fn domain_error(domain: &str, code: &str) -> CoreError {
    CoreError::DomainError {
        domain: domain.into(),
        code: code.into(),
        detail: None,
    }
}

/// A process failure as the core's error: a missing program is a missing capability, a full queue
/// is `queueFull`, everything else a coded domain failure.
fn process_failure(error: ProcessError) -> CoreError {
    match error {
        ProcessError::ProgramNotFound { program } => CoreError::CapabilityUnavailable {
            capability: program.into(),
            detail: "".into(),
        },
        ProcessError::Overloaded { queue } => CoreError::QueueFull {
            queue: match queue {
                ProcessQueue::Spawn => "process-spawn",
                ProcessQueue::Input => "process-input",
            }
            .into(),
        },
        ProcessError::UnknownHandle => domain_error("process", "UNKNOWN_HANDLE"),
        ProcessError::HandleInUse => domain_error("process", "HANDLE_IN_USE"),
        ProcessError::PermissionDenied => domain_error("process", "PERMISSION_DENIED"),
        ProcessError::LimitReached { .. } => domain_error("process", "LIMIT_REACHED"),
        ProcessError::NotPty => domain_error("process", "NOT_PTY"),
        ProcessError::StdinClosed => domain_error("process", "STDIN_CLOSED"),
        ProcessError::AlreadyExited => domain_error("process", "ALREADY_EXITED"),
        ProcessError::ReplayUnavailable { .. } => domain_error("process", "REPLAY_UNAVAILABLE"),
        ProcessError::Io { .. } => domain_error("process", "IO"),
        // `ProcessError` is closed in the core API; a new variant is a new code here.
        #[allow(unreachable_patterns)]
        _ => domain_error("process", "IO"),
    }
}
