//! The typed host channel to Electron (DS §12, SPEC §4.7–4.8) and the model
//! proxy (DS §12.4). Carried by the desktop's ordinary protocol connection.

use mixdog_protocol::HostId;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::rpc::RequestId;

/// Claims the host role for this install (`hostId` generated per install).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostClaimParams {
    pub host_id: HostId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum HostStateKey {
    BrowserTabs,
    BrowserImport,
    Visualize,
    DisplayPreferences,
}

/// Publishes desktop-owned state into section `hostState`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostStateSetParams {
    pub key: HostStateKey,
    pub value: JsonValue,
}

/// SSH server core the local core bridges phone connections to (R25).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct HostRemoteTargetSetParams {
    /// `ws://127.0.0.1:<port>/rpc` of the tunnel; absent = the local core.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct HostCommandParams {
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct HostSystemProxyResolveParams {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct HostSystemProxyResolveResponse {
    /// Chromium proxy rules for the URL (`DIRECT`, `PROXY host:port`, …).
    pub rules: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum UpdaterAction {
    Check,
    Install,
}

/// Params of `host/update/command` (core → host).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct HostUpdateCommandParams {
    pub action: UpdaterAction,
}

/// Params of `update/desktop/command` (any client → core).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDesktopCommandParams {
    pub op_id: mixdog_protocol::OpId,
    pub action: UpdaterAction,
}

impl crate::common::HasOpId for UpdateDesktopCommandParams {
    fn op_id(&self) -> &mixdog_protocol::OpId {
        &self.op_id
    }
}

/// Params of `host/capture/fileSnapshot` (core → host). The core has already confined the path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct HostFileSnapshotParams {
    pub root: String,
    pub rel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<bool>,
}

/// Result of `host/capture/fileSnapshot`: the picture of the file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostFileSnapshot {
    /// `data:image/png;base64,…` or `data:image/jpeg;base64,…`.
    pub data_url: String,
    pub mtime_ms: f64,
    #[ts(type = "number")]
    pub size: u64,
}

/// What a `host/localPage/url` lease covers; absent means `project`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum LocalPageScope {
    File,
    Project,
}

/// Params of `host/localPage/url` (core → host); the result is the URL string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct HostLocalPageUrlParams {
    pub root: String,
    pub rel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<LocalPageScope>,
}

/// The visualize service's actions (`host/visualize/command`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum VisualizeAction {
    Open,
    Close,
    Annotate,
    Capture,
    Export,
    Check,
    Inspect,
    Act,
}

/// Params of `host/visualize/command` (core → host): the loopback bridge's request body.
/// The result is the service's object (`{text, tabs?, path?, …}`), `{}` when it returns nothing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct HostVisualizeCommandParams {
    pub session_id: String,
    pub cwd: String,
    pub action: VisualizeAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct HostNotificationShowParams {
    pub title: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sound: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
}

/// First viewer → `on`, last viewer gone → `off` (SPEC §4.7.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostBrowserViewFramesParams {
    pub tab_id: String,
    /// The X17 `streamId` the host stamps on this tab's frames.
    pub stream_id: u32,
    pub on: bool,
    /// Phone stream request (fit, quality) as today's take-over request.
    pub request: JsonValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PowerEvent {
    Suspend,
    Resume,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct HostPowerParams {
    pub event: PowerEvent,
}

/// Today's `DesktopUpdaterState`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct HostUpdateReportParams {
    pub state: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostNotificationClickedParams {
    pub thread_id: ThreadId,
}

/// `client/activity`: sent on user input, at most once per 60 s (client-side rate).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ClientActivityParams {
    #[ts(type = "number")]
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ClientPerfLogParams {
    pub line: String,
}

/// App-feed event: a web URL the agent opened is handed to the session's browser panel.
/// Node's `openUrl` visualize event (`visualize/open-actions.ts` `openUrl`), field for field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct UiOpenRequestedParams {
    pub session_id: String,
    pub open_url: String,
    /// Names the request, so the browser tab the pane creates reports back to the agent's open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_request_id: Option<String>,
}

/// App-feed event: remote pointer position (today's `notify` remote pointer).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct RemotePointerParams {
    pub pointer: JsonValue,
}

/// Server core → a connection with `capabilities.modelProxy`: run one model call
/// with this machine's accounts. Completion is the response; losing the
/// connection resolves the call `cancelled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ModelProxyExecuteParams {
    pub call: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ModelProxyResult {
    pub result: JsonValue,
}

/// Electron → server core: one streamed event of a `model/proxy/execute` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelProxyEventParams {
    pub request_id: RequestId,
    pub event: JsonValue,
}

/// Electron → its local core: execute a proxied call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelProxyRunParams {
    /// Stream id the local core stamps on `modelProxy/run/event`.
    pub run_id: String,
    pub call: JsonValue,
}

/// Local core → Electron: one streamed event of a `modelProxy/run` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelProxyRunEventParams {
    pub run_id: String,
    pub event: JsonValue,
}
