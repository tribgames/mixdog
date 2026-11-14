//! The projection the UI reads: the fold, the pending server requests and the `hostShellJobs` section joined into one record
//! (`desktopSessionState` of `packages/protocol-client/src/session-state.ts`). The projection is the reducer task's; until it lands
//! the projected state is the fold's state. [`PROJECTED_FIELDS`] is what it is to produce: the audit of the fields the UI reads
//! (`tests/fixtures/tui-state-fields.json`) is proven against it.

use mixdog_app_protocol::ServerRequest;
use mixdog_app_server_client::ThreadFold;
use serde_json::Value;

/// The fold of one session: the client's folded thread.
pub type SessionFold = ThreadFold;

/// Every field of the projected state: the fields the sections own, the snapshot's and the feed's, then the ones the projection sets.
pub const PROJECTED_FIELDS: &[&str] = &[
    // thread/runtime/updated
    "busy",
    "commandBusy",
    "thinking",
    "spinner",
    "commandStatus",
    "progressHint",
    "activeTools",
    "clientHostPid",
    "toasts",
    "activeToolSummary",
    "toolMode",
    "setupChanged",
    // thread/route/updated
    "sessionProvider",
    "sessionModel",
    "fast",
    "fastCapable",
    "autoEffort",
    "modelParameters",
    "selectedContextWindow",
    "effort",
    "provider",
    "model",
    "turnEffort",
    "effortOptions",
    "cwd",
    "sessionForkedFrom",
    "systemShell",
    "webSearchRoute",
    "autoClear",
    // thread/context/updated
    "contextPercent",
    "contextTokens",
    "contextDefaultPercent",
    "contextWindow",
    "displayContextWindow",
    "autoCompactTokenLimit",
    "stats",
    "rawContextWindow",
    "effectiveContextWindowPercent",
    "compactBoundaryTokens",
    // thread/agents/updated, thread/workflow/updated, thread/approvals/updated
    "agentWorkers",
    "agentJobs",
    "agentScope",
    "workflow",
    "orchestrationMode",
    "pendingWorkflowSwitch",
    "pendingOrchestrationModeSwitch",
    "toolApprovalResult",
    "handoffQuestions",
    // the one-field sections
    "todo",
    "goal",
    "quotaResume",
    "shellJobs",
    "workspace",
    "promptRestore",
    "providerAccountChange",
    "remoteEnabled",
    "setupUiRequest",
    // the snapshot and the feed's own notifications
    "desktopSessionTitle",
    "transcriptHasOlder",
    "promptHistoryList",
    "queued",
    // set by the projection
    "sessionId",
    "items",
    "structureRevision",
    "streamingTail",
    "streamingPartial",
    "transcriptViewItems",
    "transcriptViewRevision",
    "transcriptHistoryBefore",
    "transcriptHistoryAfter",
    "transcriptArchive",
    "transcriptSpilled",
    "lastTurn",
    "themeEpoch",
    "remoteSessionId",
    "hostShellJobs",
    "toolApproval",
    "toolApprovalsWaiting",
];

/// The state of the folded session, with the pending server requests and the host's shell jobs joined in.
pub fn desktop_session_state(
    fold: &SessionFold,
    _requests: &[ServerRequest],
    _host_shell_jobs: Option<&Value>,
) -> Value {
    fold.state.clone()
}
