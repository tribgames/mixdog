//! Requests from the core to clients (P §8.1, R18, R41, DS §12.3–12.4).
//! `mcpServer/elicitation/request` is not in the 1.4.6 set (R41).

#[cfg(feature = "codegen")]
use mixdog_protocol::JsonValue;
#[cfg(feature = "codegen")]
use mixdog_protocol::ToolApprovalDecision;

use crate::v2::approval::*;
use crate::v2::host::*;

crate::server_request_definitions! {
    /// Every tool approval, including human gates (`kind: humanGate`).
    ToolRequestApproval => "item/tool/requestApproval" {
        params: ToolApprovalRequestParams,
        result: ToolApprovalDecision,
        requires: None,
    },
    /// `ask_user` questions, including room hand-off questions.
    ToolRequestUserInput => "item/tool/requestUserInput" {
        params: UserInputRequestParams,
        result: ToolApprovalDecision,
        requires: None,
    },
    PermissionsRequestApproval => "item/permissions/requestApproval" {
        params: PermissionsRequestParams,
        result: ToolApprovalDecision,
        requires: None,
    },
    /// Raised by the core's browser policy; any eligible client presents it.
    BrowserRequestApproval => "item/browser/requestApproval" {
        params: BrowserApprovalRequestParams,
        result: ToolApprovalDecision,
        requires: None,
    },
    /// PC access for computer use.
    ComputerRequestApproval => "item/computer/requestApproval" {
        params: ComputerApprovalRequestParams,
        result: ToolApprovalDecision,
        requires: None,
    },
    /// `browser` / `browser_devtools` tool actions and UI browser commands.
    HostBrowserCommand => "host/browser/command" {
        params: HostCommandParams,
        result: JsonValue,
        requires: Some("host.browser"),
    },
    HostVisualizeCommand => "host/visualize/command" {
        params: HostVisualizeCommandParams,
        result: Option<JsonValue>,
        requires: Some("host.visualize"),
    },
    HostSystemProxyResolve => "host/systemProxy/resolve" {
        params: HostSystemProxyResolveParams,
        result: HostSystemProxyResolveResponse,
        requires: Some("host.systemProxy"),
    },
    /// This PC's notification support and system idle time, which decides whether paired
    /// devices hold their pushes (Node's host method `notificationStatus`).
    HostNotificationStatus => "host/notification/status" {
        params: HostNotificationStatusParams,
        result: HostNotificationStatus,
        requires: Some("host.notifications"),
    },
    HostUpdateCommand => "host/update/command" {
        params: HostUpdateCommandParams,
        result: JsonValue,
        requires: Some("host.updater"),
    },
    HostCaptureFileSnapshot => "host/capture/fileSnapshot" {
        params: HostFileSnapshotParams,
        result: HostFileSnapshot,
        requires: Some("host.files"),
    },
    HostLocalPageUrl => "host/localPage/url" {
        params: HostLocalPageUrlParams,
        result: String,
        requires: Some("host.files"),
    },
    /// The OS trash is the desktop window's (Node's `trashItem` host request).
    HostFilesTrashItem => "host/files/trashItem" {
        params: HostFilesTrashItemParams,
        result: JsonValue,
        requires: Some("host.files"),
    },
    /// A server core's model call executed with this machine's accounts.
    ModelProxyExecute => "model/proxy/execute" {
        params: ModelProxyExecuteParams,
        result: ModelProxyResult,
        requires: Some("modelProxy"),
    },
}
