//! Server notifications (core → client) and client notifications (P §5.1,
//! §6.2, DS §2, §12.3). Every feed-delivered notification carries the
//! envelope `feed` stamp; `Connection` ones carry none.

use mixdog_protocol::JsonValue;
use mixdog_protocol::LoginFlowId;
use mixdog_protocol::ProcessHandle;
use mixdog_protocol::ProviderErrorDetail;
use mixdog_protocol::QuotaResume;
use mixdog_protocol::SearchSessionId;
use mixdog_protocol::SectionUpdate;
use mixdog_protocol::TerminalTabId;
use mixdog_protocol::ThreadId;
use mixdog_protocol::WatchId;
use serde::Deserialize;
use serde::Serialize;

use crate::rpc::JsonRpcErrorBody;
use crate::v2::approval::ServerRequestResolvedParams;
use crate::v2::feed::AppSnapshotParams;
use crate::v2::feed::FeedSnapshotParams;
use crate::v2::host::BrowserWebrtcSignalParams;
use crate::v2::host::HostBrowserViewFramesParams;
use crate::v2::host::CoreDrainParams;
use crate::v2::host::HostNotificationShowParams;
use crate::v2::host::ModelProxyCancelParams;
use crate::v2::host::ModelProxyRunEventParams;
use crate::v2::host::RemotePointerParams;
use crate::v2::host::UiOpenRequestedParams;
use crate::v2::thread::*;

/// `error`: a connection-scoped failure, or a thread error with `willRetry`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ErrorNotificationParams {
    pub error: JsonRpcErrorBody,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub will_retry: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_error: Option<ProviderErrorDetail>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct WarningParams {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    /// `configWarning`: the offending config path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FsChangedParams {
    pub watch_id: WatchId,
    pub changed_paths: Vec<String>,
    /// `modified` | `removed` | `renamed` | `git` | `overflow`.
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SearchUpdatedParams {
    pub session_id: SearchSessionId,
    pub query: String,
    pub files: Vec<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SearchCompletedParams {
    pub session_id: SearchSessionId,
    pub query: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProcessOutputDeltaParams {
    pub process_handle: ProcessHandle,
    pub bytes_b64: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ProcessExitedParams {
    pub process_handle: ProcessHandle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LoginUpdatedParams {
    pub flow_id: LoginFlowId,
    /// Device code, verification URL, `waiting|done|failed`, error.
    pub state: JsonValue,
}

crate::notification_definitions! {
    enum ServerNotification;
    table SERVER_NOTIFICATIONS;
    visit visit_server_notifications;
    // ---- thread feed (P §5.1)
    /// Atomic snapshot at the feed seq it is stamped with.
    ThreadSnapshot => "thread/snapshot" (ThreadSnapshotParams) @thread,
    ThreadClosed => "thread/closed" (ThreadIdParams) @thread,
    ThreadStatusChanged => "thread/status/changed" (ThreadStatusChangedParams) @thread,
    ThreadNameUpdated => "thread/name/updated" (ThreadNameUpdatedParams) @thread,
    ThreadTokenUsageUpdated => "thread/tokenUsage/updated" (TokenUsageUpdatedParams) @thread,
    ThreadGoalUpdated => "thread/goal/updated" (ThreadValueParams) @thread,
    ThreadGoalCleared => "thread/goal/cleared" (ThreadIdParams) @thread,
    ThreadQueueChanged => "thread/queue/changed" (ThreadQueueChangedParams) @thread,
    TurnStarted => "turn/started" (TurnNotificationParams) @thread,
    TurnCompleted => "turn/completed" (TurnNotificationParams) @thread,
    ThreadNotification => "thread/notification" (ThreadNotificationParams) @thread,
    ThreadModelRequestUpdated => "thread/modelRequest/updated" (ModelRequestUpdatedParams) @thread,
    ThreadToolBatchUpdated => "thread/toolBatch/updated" (ToolBatchUpdatedParams) @thread,
    ItemStarted => "item/started" (ItemNotificationParams) @thread,
    /// The authoritative, persisted row.
    ItemCompleted => "item/completed" (ItemNotificationParams) @thread,
    AgentMessageDelta => "item/agentMessage/delta" (ItemDeltaParams) @thread,
    ReasoningTextDelta => "item/reasoning/textDelta" (ItemDeltaParams) @thread,
    ReasoningSummaryTextDelta => "item/reasoning/summaryTextDelta" (ItemDeltaParams) @thread,
    ThreadHistoryReset => "thread/historyReset" (ThreadHistoryResetParams) @thread,
    ThreadRuntimeUpdated => "thread/runtime/updated" (ThreadSectionParams<ThreadRuntime>) @thread,
    ThreadRouteUpdated => "thread/route/updated" (ThreadSectionParams<ThreadRoute>) @thread,
    ThreadContextUpdated => "thread/context/updated" (ThreadSectionParams<ThreadContext>) @thread,
    ThreadTodoUpdated => "thread/todo/updated" (ThreadSectionParams<Option<JsonValue>>) @thread,
    ThreadQuotaResumeUpdated => "thread/quotaResume/updated" (ThreadSectionParams<Option<QuotaResume>>) @thread,
    ThreadAgentsUpdated => "thread/agents/updated" (ThreadSectionParams<ThreadAgents>) @thread,
    ThreadShellJobsUpdated => "thread/shellJobs/updated" (ThreadSectionParams<JsonValue>) @thread,
    ThreadWorkflowUpdated => "thread/workflow/updated" (ThreadSectionParams<ThreadWorkflow>) @thread,
    ThreadWorkspaceUpdated => "thread/workspace/updated" (ThreadSectionParams<Option<JsonValue>>) @thread,
    ThreadApprovalsUpdated => "thread/approvals/updated" (ThreadSectionParams<ThreadApprovals>) @thread,
    ThreadPromptRestore => "thread/promptRestore" (ThreadSectionParams<Option<PromptRestore>>) @thread,
    ThreadProviderAccountChanged => "thread/providerAccount/changed" (ThreadSectionParams<Option<ProviderAccountChange>>) @thread,
    ThreadPromptHistoryUpdated => "thread/promptHistory/updated" (ThreadSectionParams<PromptHistoryChange>) @thread,
    ThreadRemoteUpdated => "thread/remote/updated" (ThreadSectionParams<bool>) @thread,
    ThreadSetupUiRequestUpdated => "thread/setupUiRequest/updated" (ThreadSectionParams<Option<SetupUiRequest>>) @thread,
    /// Section `roomView`: a group room log's view while the room runs (`decorateRoomSnapshot`).
    ThreadRoomViewUpdated => "thread/roomView/updated" (ThreadSectionParams<Option<ThreadRoomView>>) @thread,
    /// Section `reviewDiff`, key = thread id.
    ReviewDiffUpdated => "review/diff/updated" (SectionUpdate) @thread,
    // ---- connection-scoped
    Error => "error" (ErrorNotificationParams) @connection,
    ServerRequestResolved => "serverRequest/resolved" (ServerRequestResolvedParams) @connection,
    HostNotificationShow => "host/notification/show" (HostNotificationShowParams) @connection,
    HostBrowserViewFrames => "host/browser/viewFrames" (HostBrowserViewFramesParams) @connection,
    /// The core's live-view signal to one phone (offer, candidate, promote, demote, close, geometry).
    BrowserWebrtcSignal => "browser/webrtcSignal" (BrowserWebrtcSignalParams) @connection,
    ModelProxyRunEvent => "modelProxy/run/event" (ModelProxyRunEventParams) @connection,
    ModelProxyCancel => "model/proxy/cancel" (ModelProxyCancelParams) @connection,
    // ---- app feed (P §6.2, DS §2.4)
    AppSnapshot => "app/snapshot" (AppSnapshotParams) @app,
    ThreadStarted => "thread/started" (ThreadStartedParams) @app,
    ThreadSummaryUpdated => "thread/summary/updated" (ThreadSummaryUpdatedParams) @app,
    ThreadDeleted => "thread/deleted" (ThreadIdParams) @app,
    ThreadArchived => "thread/archived" (ThreadIdParams) @app,
    ThreadUnarchived => "thread/unarchived" (ThreadIdParams) @app,
    Warning => "warning" (WarningParams) @app,
    ConfigWarning => "configWarning" (WarningParams) @app,
    UiOpenRequested => "ui/openRequested" (UiOpenRequestedParams) @app,
    RemotePointer => "remote/pointer" (RemotePointerParams) @app,
    /// Draining: what still runs and the token that authorizes an abort (`lifecycle-remote.md` §5.1).
    CoreDrain => "core/drain" (CoreDrainParams) @app,
    ConfigUpdated => "config/updated" (SectionUpdate) @app,
    ProjectUpdated => "project/updated" (SectionUpdate) @app,
    AgentPoolUpdated => "agent/pool/updated" (SectionUpdate) @app,
    AgentListUpdated => "agent/list/updated" (SectionUpdate) @app,
    AgentBotOrderUpdated => "agent/botOrder/updated" (SectionUpdate) @app,
    ModelPresetsUpdated => "model/presets/updated" (SectionUpdate) @app,
    ModelCatalogUpdated => "model/catalog/updated" (SectionUpdate) @app,
    WorkflowListUpdated => "workflow/list/updated" (SectionUpdate) @app,
    WebSearchUpdated => "webSearch/updated" (SectionUpdate) @app,
    ToolModulesUpdated => "toolModules/updated" (SectionUpdate) @app,
    /// Sections `providerSetup` and `providerAccounts`.
    AccountUpdated => "account/updated" (SectionUpdate) @app,
    UsageUpdated => "usage/updated" (SectionUpdate) @app,
    HostShellJobsUpdated => "shellJobs/host/updated" (SectionUpdate) @app,
    TerminalActivityUpdated => "terminal/activity/updated" (SectionUpdate) @app,
    TerminalTabsUpdated => "terminal/tabs/updated" (SectionUpdate) @app,
    RemoteStateUpdated => "remote/state/updated" (SectionUpdate) @app,
    NoticeUpdated => "notice/updated" (SectionUpdate) @app,
    UpdateStatusUpdated => "update/status/updated" (SectionUpdate) @app,
    HostStateUpdated => "host/state/updated" (SectionUpdate) @app,
    ComputerUpdated => "computer/updated" (SectionUpdate) @app,
    ApprovalInboxUpdated => "approval/inbox/updated" (SectionUpdate) @app,
    CoreStateUpdated => "core/state/updated" (SectionUpdate) @app,
    CoreHealthUpdated => "core/health/updated" (SectionUpdate) @app,
    MigrationProgress => "migration/progress" (SectionUpdate) @app,
    // ---- scoped feeds (DS §2.1)
    /// Snapshot of any scoped feed (its read model).
    FeedSnapshot => "feed/snapshot" (FeedSnapshotParams) @scoped(Any),
    FsChanged => "fs/changed" (FsChangedParams) @scoped(Fs),
    SearchUpdated => "search/updated" (SearchUpdatedParams) @scoped(Search),
    SearchCompleted => "search/completed" (SearchCompletedParams) @scoped(Search),
    ProcessOutputDelta => "process/outputDelta" (ProcessOutputDeltaParams) @scoped(Process),
    ProcessExited => "process/exited" (ProcessExitedParams) @scoped(Process),
    LoginUpdated => "login/updated" (LoginUpdatedParams) @scoped(Login),
    GitStatusUpdated => "git/status/updated" (SectionUpdate) @scoped(Git),
    LspStatusUpdated => "lsp/status/updated" (SectionUpdate) @scoped(Lsp),
    LspDiagnosticsUpdated => "lsp/diagnostics/updated" (SectionUpdate) @scoped(Lsp),
    MediaJobUpdated => "media/job/updated" (SectionUpdate) @scoped(Media),
    SystemPortsUpdated => "system/ports/updated" (SectionUpdate) @scoped(Ports),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalInputParams {
    pub tab_id: TerminalTabId,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeParams {
    pub tab_id: TerminalTabId,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProcessInputParams {
    pub process_handle: ProcessHandle,
    pub bytes_b64: String,
}

/// Client notifications (X11): they take no in-flight slot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "method", content = "params")]
pub enum ClientNotification {
    /// No params; changes no state.
    #[serde(rename = "initialized")]
    #[cfg_attr(feature = "codegen", ts(rename = "initialized"))]
    Initialized,
    #[serde(rename = "terminal/input")]
    #[cfg_attr(feature = "codegen", ts(rename = "terminal/input"))]
    TerminalInput(TerminalInputParams),
    /// Ignored unless the sender owns the PTY size.
    #[serde(rename = "terminal/resize")]
    #[cfg_attr(feature = "codegen", ts(rename = "terminal/resize"))]
    TerminalResize(TerminalResizeParams),
    #[serde(rename = "process/input")]
    #[cfg_attr(feature = "codegen", ts(rename = "process/input"))]
    ProcessInput(ProcessInputParams),
    #[serde(rename = "client/activity")]
    #[cfg_attr(feature = "codegen", ts(rename = "client/activity"))]
    ClientActivity(crate::v2::host::ClientActivityParams),
    #[serde(rename = "client/perfLog")]
    #[cfg_attr(feature = "codegen", ts(rename = "client/perfLog"))]
    ClientPerfLog(crate::v2::host::ClientPerfLogParams),
    #[serde(rename = "host/power")]
    #[cfg_attr(feature = "codegen", ts(rename = "host/power"))]
    HostPower(crate::v2::host::HostPowerParams),
    #[serde(rename = "host/update/report")]
    #[cfg_attr(feature = "codegen", ts(rename = "host/update/report"))]
    HostUpdateReport(crate::v2::host::HostUpdateReportParams),
    /// The window process's browser host revealed or hid a session's surface (an agent's explicit
    /// `open`/`hide`); the core publishes it as `ui/openRequested { kind: "browser" }`.
    #[serde(rename = "host/browser/surface")]
    #[cfg_attr(feature = "codegen", ts(rename = "host/browser/surface"))]
    HostBrowserSurface(crate::v2::host::HostBrowserSurfaceParams),
    /// What a viewed browser page shows now: its document and locked geometry (`null` = ended).
    #[serde(rename = "host/browser/page")]
    #[cfg_attr(feature = "codegen", ts(rename = "host/browser/page"))]
    HostBrowserPage(crate::v2::host::HostBrowserPageParams),
    #[serde(rename = "host/notification/clicked")]
    #[cfg_attr(feature = "codegen", ts(rename = "host/notification/clicked"))]
    HostNotificationClicked(crate::v2::host::HostNotificationClickedParams),
    /// One streamed event of a `model/proxy/execute` request.
    #[serde(rename = "model/proxy/event")]
    #[cfg_attr(feature = "codegen", ts(rename = "model/proxy/event"))]
    ModelProxyEvent(crate::v2::host::ModelProxyEventParams),
    /// The PC still runs these `model/proxy/execute` requests (every 5 s); the first claims a request.
    #[serde(rename = "model/proxy/heartbeat")]
    #[cfg_attr(feature = "codegen", ts(rename = "model/proxy/heartbeat"))]
    ModelProxyHeartbeat(crate::v2::host::ModelProxyHeartbeatParams),
    /// Stops the `modelProxy/run` run `runId` of the sender.
    #[serde(rename = "modelProxy/cancel")]
    #[cfg_attr(feature = "codegen", ts(rename = "modelProxy/cancel"))]
    ModelProxyRunCancel(crate::v2::host::ModelProxyRunCancelParams),
    /// The pane created the tab a `ui/openRequested` visualize open asked for.
    #[serde(rename = "ui/newTab/created")]
    #[cfg_attr(feature = "codegen", ts(rename = "ui/newTab/created"))]
    UiNewTabCreated(crate::v2::host::UiNewTabCreatedParams),
    /// A pane shows the terminal of a `ui/openRequested` terminal open.
    #[serde(rename = "ui/terminalRun/claimed")]
    #[cfg_attr(feature = "codegen", ts(rename = "ui/terminalRun/claimed"))]
    UiTerminalRunClaimed(crate::v2::host::UiTerminalRunClaimedParams),
    /// The sessions the user is looking at (the desktop notifier's `isSessionOnScreen`).
    #[serde(rename = "ui/screenSessions/changed")]
    #[cfg_attr(feature = "codegen", ts(rename = "ui/screenSessions/changed"))]
    UiScreenSessionsChanged(crate::v2::host::UiScreenSessionsChangedParams),
}

pub static CLIENT_NOTIFICATIONS: &[crate::common::NotificationSpec] = &[
    crate::common::NotificationSpec {
        method: "initialized",
        params: "()",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "terminal/input",
        params: "TerminalInputParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "terminal/resize",
        params: "TerminalResizeParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "process/input",
        params: "ProcessInputParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "client/activity",
        params: "ClientActivityParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "client/perfLog",
        params: "ClientPerfLogParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "host/power",
        params: "HostPowerParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "host/update/report",
        params: "HostUpdateReportParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "host/browser/surface",
        params: "HostBrowserSurfaceParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "host/browser/page",
        params: "HostBrowserPageParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "host/notification/clicked",
        params: "HostNotificationClickedParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "model/proxy/event",
        params: "ModelProxyEventParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "model/proxy/heartbeat",
        params: "ModelProxyHeartbeatParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "modelProxy/cancel",
        params: "ModelProxyRunCancelParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "ui/newTab/created",
        params: "UiNewTabCreatedParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "ui/terminalRun/claimed",
        params: "UiTerminalRunClaimedParams",
        delivery: None,
    },
    crate::common::NotificationSpec {
        method: "ui/screenSessions/changed",
        params: "UiScreenSessionsChangedParams",
        delivery: None,
    },
];

impl ClientNotification {
    /// Typed decode of a received notification; `params` absent is allowed only for `initialized`.
    pub fn from_jsonrpc(
        notification: crate::rpc::JsonRpcNotification,
    ) -> Result<Self, crate::common::RequestDecodeError> {
        let Some(spec) = CLIENT_NOTIFICATIONS
            .iter()
            .find(|spec| spec.method == notification.method)
        else {
            return Err(crate::common::RequestDecodeError::MethodNotFound(
                notification.method,
            ));
        };
        let mut object = serde_json::Map::new();
        object.insert("method".to_owned(), JsonValue::String(notification.method));
        if let Some(params) = notification.params {
            object.insert("params".to_owned(), params);
        }
        serde_json::from_value(JsonValue::Object(object)).map_err(|error| {
            crate::common::RequestDecodeError::InvalidParams {
                method: spec.method,
                detail: error.to_string(),
            }
        })
    }
}

/// The section notification names agree with `SectionName::notification_method`.
pub fn section_notification_methods() -> impl Iterator<Item = &'static str> {
    mixdog_protocol::SectionName::ALL
        .iter()
        .map(|name| name.notification_method())
}
