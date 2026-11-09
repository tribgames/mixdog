//! The typed host channel to Electron (DS §12, SPEC §4.7–4.8) and the model
//! proxy (DS §12.4). Carried by the desktop's ordinary protocol connection.

use mixdog_protocol::HostId;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use serde::Deserialize;
use serde::Serialize;

use crate::rpc::RequestId;

/// Claims the host role for this install (`hostId` generated per install).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostClaimParams {
    pub host_id: HostId,
}

/// Publishes desktop-owned state into section `hostState`: `{key, value}`, the value's shape
/// picked by the key. Only `visualize` is typed; the others stay the desktop's own JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "key", content = "value", rename_all = "camelCase")]
pub enum HostStateSetParams {
    BrowserTabs(JsonValue),
    BrowserImport(JsonValue),
    Visualize(VisualizeHostValue),
    DisplayPreferences(JsonValue),
}

impl HostStateSetParams {
    /// The section key and the value to publish under it.
    pub fn into_parts(self) -> (&'static str, JsonValue) {
        match self {
            Self::BrowserTabs(value) => ("browserTabs", value),
            Self::BrowserImport(value) => ("browserImport", value),
            Self::Visualize(value) => ("visualize", serde_json::to_value(value).unwrap_or_default()),
            Self::DisplayPreferences(value) => ("displayPreferences", value),
        }
    }
}

/// What the desktop publishes under `visualize`: the visualize service's `hostSnapshot()`
/// (every session's state, sent again on each claim) or one `publishRemote` change event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(untagged)]
pub enum VisualizeHostValue {
    Snapshot(Vec<VisualizeHostState>),
    Event(VisualizeHostEvent),
}

/// `VisualizeHostEvent` (`apps/desktop/src/shared/visualize.ts`), main → core: the change
/// `DesktopVisualizeEvent` carries, with host paths.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct VisualizeHostEvent {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<VisualizeHostState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reveal: Option<bool>,
    /// With `reveal`: the tab the open or update was for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
    /// A content update of this tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    /// Sent while the session's agent turn runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held: Option<bool>,
    /// With `held`: when the turn started (ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub held_since: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_url: Option<String>,
}

/// One session's tabs with their resolved files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct VisualizeHostState {
    pub session_id: String,
    pub tabs: Vec<VisualizeHostTab>,
    /// Always written; `null` when no tab is active.
    #[cfg_attr(feature = "codegen", ts(optional = false, type = "string | null"))]
    pub active: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<Vec<VisualizeHistoryItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gone_opens: Option<Vec<VisualizeGoneOpen>>,
}

/// `Some(None)` is a written `null`, `None` a missing key.
fn null_or_value<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct VisualizeHostTab {
    pub id: String,
    pub label: String,
    /// The label a remote client sees.
    pub remote_label: String,
    pub revision: u32,
    /// The working directory every pane and page asset must stay inside.
    pub cwd: String,
    pub panes: Vec<VisualizeHostPane>,
    /// Always `true` when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "true"))]
    pub missing: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problems: Option<Vec<VisualizeProblem>>,
    /// Always `true` when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "true"))]
    pub network_allowed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub versions: Option<Vec<VisualizeVersionView>>,
    /// The version shown instead of the live files; `null` = live.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "null_or_value")]
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub version: Option<Option<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compare: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_assets: Option<Vec<String>>,
    /// A data URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Vec<VisualizeAnnotation>>,
}

/// A pane with the symlink-resolved file it shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct VisualizeHostPane {
    pub kind: VisualizePaneKind,
    pub label: String,
    pub target: String,
    /// `""` for an `inline` pane, which has no file.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline: Option<VisualizeInlineContent>,
    /// What a remote client is told the target is.
    pub remote_target: String,
    /// The folder this pane's file and page assets must stay inside.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    /// Inline panes: the render id a remote client's report must carry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_render_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum VisualizePaneKind {
    Html,
    Document,
    Pdf,
    Image,
    Audio,
    Video,
    Inline,
}

/// What `open` can render straight from `input.content`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum VisualizeInlineKind {
    Mermaid,
    Svg,
    Chart,
    Html,
    Markdown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct VisualizeInlineContent {
    pub kind: VisualizeInlineKind,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Always `true` when present: a device's snapshot left the source out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "true"))]
    pub deferred: Option<bool>,
}

/// One kept version of a tab's files (`n` counts up per tab from 1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct VisualizeVersionView {
    pub n: u32,
    /// When it was kept (ms since epoch).
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<Vec<VisualizeVersionTurn>>,
}

/// One agent turn's span (ms since epoch).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct VisualizeVersionTurn {
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub since: i64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub end: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum VisualizeProblemKind {
    Exception,
    Rejection,
    Csp,
    AssetFailed,
    BlockedNetwork,
    BlockedNavigation,
    Load,
    ConsoleError,
    ConsoleWarn,
    Render,
}

/// One distinct runtime problem of a tab's HTML pane; `source` is project-relative.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct VisualizeProblem {
    pub kind: VisualizeProblemKind,
    pub message: String,
    pub source: String,
    pub line: u32,
    pub count: u32,
    /// Index of the pane (in the tab's displayed panes) it came from.
    pub pane: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
}

/// The agent's mark on displayed pane `pane` (selectors and labels only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct VisualizeAnnotation {
    pub pane: u32,
    pub selector: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// The pane kinds and inline kinds a history entry can show, or a `split` of several.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum VisualizeHistoryKind {
    Html,
    Document,
    Pdf,
    Image,
    Audio,
    Video,
    Inline,
    Mermaid,
    Svg,
    Chart,
    Markdown,
    Split,
}

/// One thing opened in a session (open or since closed); path-free.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct VisualizeHistoryItem {
    pub id: String,
    pub label: String,
    pub kind: VisualizeHistoryKind,
    pub versions: u32,
    /// When it was last opened (ms since epoch).
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub at: i64,
    pub open: bool,
}

/// An open of a finished turn whose tab had nothing left to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct VisualizeGoneOpen {
    pub tab: String,
    pub call: String,
}

/// SSH server core the local core bridges phone connections to (R25).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostRemoteTargetSetParams {
    /// `ws://127.0.0.1:<port>/rpc` of the tunnel; absent = the local core.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostCommandParams {
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

/// Params of `host/notification/status` (core → host): none.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct HostNotificationStatusParams {}

/// Result of `host/notification/status` (Node's host method `notificationStatus`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostNotificationStatus {
    /// Whether this PC can show OS notifications (`Notification.isSupported()`).
    pub supported: bool,
    /// The OS's system idle time in seconds (`powerMonitor.getSystemIdleTime()`: input anywhere
    /// on the PC counts); `null` when the host cannot tell, which the caller treats as not
    /// active. The caller judges it against its own window (Node: 180 s).
    pub idle_seconds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct HostSystemProxyResolveParams {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct HostSystemProxyResolveResponse {
    /// Chromium proxy rules for the URL (`DIRECT`, `PROXY host:port`, …).
    pub rules: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum UpdaterAction {
    Check,
    Install,
}

/// Params of `host/update/command` (core → host).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostUpdateCommandParams {
    pub action: UpdaterAction,
    /// Node's `updaterInstall` argument `args[0]`: the user confirmed the install.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed: Option<bool>,
}

/// Params of `update/desktop/command` (any client → core).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
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

/// Params of `host/files/trashItem` (core → host): the absolute path the core has already confined.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostFilesTrashItemParams {
    pub path: String,
}

/// Params of `host/capture/fileSnapshot` (core → host). The core has already confined the path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostFileSnapshotParams {
    pub root: String,
    pub rel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<bool>,
}

/// Result of `host/capture/fileSnapshot`: the picture of the file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostFileSnapshot {
    /// `data:image/png;base64,…` or `data:image/jpeg;base64,…`.
    pub data_url: String,
    pub mtime_ms: f64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub size: u64,
}

/// What a `host/localPage/url` lease covers; absent means `project`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum LocalPageScope {
    File,
    Project,
}

/// Params of `host/localPage/url` (core → host); the result is the URL string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostLocalPageUrlParams {
    pub root: String,
    pub rel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<LocalPageScope>,
}

/// The visualize service's actions (`host/visualize/command`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
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
/// The result is the service's object (`{text, tabs?, path?, …}`), `null` when it returns nothing
/// (`visualizeCommand`: `(await visualize.command(…)) ?? null`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostVisualizeCommandParams {
    pub session_id: String,
    pub cwd: String,
    pub action: VisualizeAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostBrowserViewFramesParams {
    pub tab_id: String,
    /// The X17 `streamId` the host stamps on this tab's frames.
    pub stream_id: u32,
    pub on: bool,
    /// Phone stream request (fit, quality) as today's take-over request.
    pub request: JsonValue,
}

/// A phone's live-view signal (`browser/webrtcSignal` request, Node's `browserRemoteWebrtcSignal`
/// call) and the core's signal to that phone (the `browser/webrtcSignal` push, Node's
/// `browserRemoteWebrtc` event). `signal` is the validated wire object of
/// `mixdog-remote::webrtc::signal` (`ClientSignal` / `DesktopSignal`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebrtcSignalParams {
    pub signal: JsonValue,
}

/// `host/browser/page` (host → core notification): what a viewed browser page shows now — the
/// document and the geometry its stream locked (Node's `source.page()` and
/// `remoteMedia.geometryChanged`). `geometry` is `null` when the stream ended. The core's X17
/// frames carry pixels only; the phone's input coordinates need this.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageParams {
    pub tab_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    /// `{generation, cssWidth, cssHeight, deviceScaleFactor, pixelWidth, pixelHeight}`.
    pub geometry: Option<JsonValue>,
}

/// Params of `browser/screenDisplays` (a granted phone's request, Node's
/// `browserRemoteScreenDisplays`) and of `host/screen/displays` (core → host): none. Both answer
/// `RemoteScreenDisplaySummary[]` (`apps/desktop/src/shared/remote-webrtc.ts`), unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct ScreenDisplaysParams {}

/// What `host/browser/liveControl` carries to the viewed page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum LiveControlKind {
    /// A phone's `resize-request`: `request` is its `resize` object (`{mode: "page"}` or
    /// `{mode: "fit-client", cssWidth, cssHeight, deviceScaleFactor}`); the host resizes the page
    /// (Node's `remote.resize(sessionId, request)`).
    Resize,
    /// A phone's `ready.videoLimit`: `request` is `{maxWidth, maxHeight}`; the host may capture
    /// larger than its frame bound, up to it, and lock a new geometry (Node's
    /// `remote.widenVideo(sessionId, limit)`).
    VideoLimit,
}

/// Params of `host/browser/liveControl` (core → host): a live-view control that is not page
/// input. The page input itself goes as `host/browser/command{action:"input"}`. The result is null;
/// a failure is a JSON-RPC error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostBrowserLiveControlParams {
    pub session_id: String,
    pub kind: LiveControlKind,
    pub request: JsonValue,
}

/// `host/browser/surface` (host → core notification): the window process's browser host asked its
/// window to reveal or hide a session's browser surface (`browserRemoteOpen`). The core publishes
/// it as `ui/openRequested { kind: "browser" }` so every attached client, paired phones included,
/// opens the same surface. Fields are `UiOpenBrowser`'s.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserSurfaceParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reveal: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl From<HostBrowserSurfaceParams> for UiOpenBrowser {
    fn from(value: HostBrowserSurfaceParams) -> Self {
        Self {
            session_id: value.session_id,
            reveal: value.reveal,
            hide: value.hide,
            handoff: value.handoff,
            tab_id: value.tab_id,
            title: value.title,
            error: value.error,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum PowerEvent {
    Suspend,
    Resume,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct HostPowerParams {
    pub event: PowerEvent,
}

/// Today's `DesktopUpdaterState`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct HostUpdateReportParams {
    pub state: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostNotificationClickedParams {
    pub thread_id: ThreadId,
}

/// `client/activity`: sent on user input, at most once per 60 s (client-side rate).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct ClientActivityParams {
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct ClientPerfLogParams {
    pub line: String,
}

/// App-feed event (`desktop-services.md` §12.4): the core asks attached UIs to open something.
/// One variant per Node flow it replaces: `browser-open-requested`, `terminal-run-requested`
/// and the visualize open (`visualize/open-actions.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UiOpenRequestedParams {
    Browser(UiOpenBrowser),
    Terminal(UiOpenTerminal),
    Visualize(UiOpenVisualize),
}

/// `DesktopBrowserOpenRequest` (`shared/contract-browser.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct UiOpenBrowser {
    pub session_id: String,
    /// `false` creates or retains the surface without opening the session dock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reveal: Option<bool>,
    /// Hide only: never create or release pages; overrides `reveal`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide: Option<bool>,
    /// A takeover hand-off: the user must act on the page, so the panel opens even where closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<bool>,
    /// An agent's `open`: the page it showed (session-local id `p…`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// An agent's `open` that failed, and why: nothing is revealed for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `DesktopTerminalRunRequest` (`shared/terminal-command.ts`): the `terminal` tool ran a command
/// in one of the session's terminals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct UiOpenTerminal {
    pub session_id: String,
    /// The terminal the command went to; its tab is selected. (The spec's §6.3 sketch calls it
    /// `tabId`; Node's request, which this follows, calls it `terminalId`.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    /// Every terminal the core runs for the session: tabs the device lacks are added.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tabs: Option<Vec<UiTerminalTab>>,
    /// The core waits on this: the desktop renderer claims it once a pane really shows
    /// `terminalId`; unclaimed, the run is reported as running in the background. Not sent to
    /// paired clients.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// `DesktopTerminalRunTab`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct UiTerminalTab {
    pub id: String,
    /// Tab number within the session (1 = the session's first terminal).
    pub tab: u32,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "null_or_value")]
    #[cfg_attr(feature = "codegen", ts(type = "string | null"))]
    pub cwd: Option<Option<String>>,
}

/// The visualize open: a web URL handed to the session's browser panel (`openUrl`), or a
/// revealed tab (`reveal`, `tab`), as `DesktopVisualizeEvent` carries them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct UiOpenVisualize {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_url: Option<String>,
    /// With `openUrl`: names the request, so the browser tab the pane creates reports back to
    /// the agent's open (`ui/newTab/created`) and no other tab does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_request_id: Option<String>,
    /// An agent open or content update: bring the panel up on this tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reveal: Option<bool>,
}

/// Client notification `ui/newTab/created` (UI → core): the pane created the tab that request
/// `openRequestId` (a `ui/openRequested` visualize open with `openUrl`) asked for, and this is
/// the page's agent-facing id (`p…`), Node's `watchNewTab(...).page`.
///
/// Semantics, from `main/browser/new-tab-waiters.ts`: the core starts waiting when it publishes
/// the open and answers the agent's `open` with this page id. Only a report whose `sessionId`
/// and `openRequestId` both match the pending open settles it, once; a tab nobody named (the
/// user's "+"), another request's tab or a different session's says nothing about it. There is
/// no negative report: a pane that drops or replaces the request sends nothing, so the wait
/// ends with no page id after 3000 ms, or when the open is cancelled, a new open reuses the
/// request id, or the session's browser is released. With no page id the agent is told to find
/// the page with the browser tool's `list_tabs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct UiNewTabCreatedParams {
    pub session_id: String,
    pub open_request_id: String,
    pub page_id: String,
}

/// Client notification `ui/terminalRun/claimed` (UI → core): a pane now shows the terminal of a
/// `ui/openRequested` terminal open that carried `requestId`.
///
/// No response. The core waits for the claim 2000 ms (the renderer's 1500 ms shown-wait plus
/// 500 ms for the claim's trip back) and then settles the run as `shown: false`, reported to the
/// agent as running in the background; with no UI attached it settles `shown: false` at once. A
/// claim settles its run once: a claim for an unknown or already-settled id has no effect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct UiTerminalRunClaimedParams {
    pub request_id: String,
}

/// Client notification `ui/screenSessions/changed` (UI → core): the sessions the user is looking
/// at right now. Node asks `isSessionOnScreen(sessionId)` (`screen-sessions.ts`) at each
/// delivery: true only while the window is visible, not minimized and focused, and its page
/// reports painting that session. The host applies those window conditions itself, so this is
/// the effective set: empty while the window is hidden, minimized or unfocused, or its page is
/// gone (reload, navigation, renderer crash). It is a full replacement, sent on every change of
/// the set (a report from the page, focus, blur, minimize, hide, show) and once when the UI
/// attaches. The core treats a session as on screen only while it is in the latest set, and
/// treats a detached UI as an empty set. No response.
///
/// A paired phone sends the same notification over its relay connection, with its page
/// visibility and app foreground applied. `browserId` is the id its direct Web Push
/// subscription is keyed by (Node's `setForeground(visible, browserId)`): at most 64 UTF-16
/// units, kept until the phone states another, and ignored on every connection that is not a
/// relay connection.
///
/// On a relay connection two more optional fields carry what Node's phone sent as `setForeground`
/// and `setVisualizePanels`: `foreground` (false = the app is backgrounded; a connection starts in
/// the foreground) and `visualizeSessionIds` (the sessions whose visualize panel the page shows;
/// none until stated). Each is kept until the phone states another, and ignored on every
/// connection that is not a relay connection. A paired phone counts as viewing a session's
/// visualize panel (`hostState` key `remoteViewing`) only while attached, in the foreground and
/// with that session in `visualizeSessionIds` (Node's `clientViewsSessionLane`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct UiScreenSessionsChangedParams {
    pub session_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visualize_session_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<bool>,
}

/// Notification `core/drain` (`lifecycle-remote.md` §5.1 step 2): the core is draining; sent to
/// every connected client with what is still running, and the token that authorizes an abort.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreDrainParams {
    pub drain_id: String,
    pub running: Vec<DrainRunning>,
    pub confirm_token: String,
}

/// One unit of running work, as listed to the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DrainRunning {
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub kind: crate::mgmt::ActivityKind,
    pub title: String,
}

/// App-feed event: remote pointer position (today's `notify` remote pointer).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct RemotePointerParams {
    pub pointer: JsonValue,
}

/// Server core → a connection with `capabilities.modelProxy`: run one model call
/// with this machine's accounts. Completion is the response; losing the
/// connection resolves the call `cancelled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct ModelProxyExecuteParams {
    pub call: crate::v2::model_proxy::ProxyCall,
}

/// A failed call answers with a JSON-RPC error whose data is a
/// [`crate::v2::model_proxy::ProxyFailure`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct ModelProxyResult {
    pub result: crate::v2::model_proxy::ProxyAnswer,
}

/// Electron → server core: one streamed event of a `model/proxy/execute` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ModelProxyEventParams {
    pub request_id: RequestId,
    pub event: crate::v2::model_proxy::ProxyEvent,
}

/// Electron → server core: these `model/proxy/execute` requests are still being run; the first beat of a request claims it, each renews its lease.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ModelProxyHeartbeatParams {
    pub request_ids: Vec<RequestId>,
}

/// Electron → its local core: execute a proxied call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ModelProxyRunParams {
    /// Stream id the local core stamps on `modelProxy/run/event`.
    pub run_id: String,
    pub call: crate::v2::model_proxy::ProxyCall,
    /// The providers this server may use through this PC: the host's saved list, `null` for every provider enabled here. Always sent: a message without it is refused, never read as every provider.
    #[serde(deserialize_with = "required_list")]
    #[cfg_attr(feature = "codegen", schemars(required))]
    pub allowed_providers: Option<Vec<String>>,
}

/// A key that must be written, `null` or a list: serde reads a missing `Option` key as `None`, which here would be "every provider".
fn required_list<'de, D>(deserializer: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<Vec<String>>::deserialize(deserializer)
}

/// Local core → Electron: one streamed event of a `modelProxy/run` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ModelProxyRunEventParams {
    pub run_id: String,
    pub event: crate::v2::model_proxy::ProxyEvent,
}

/// Server core → the connection running a `model/proxy/execute` request: the call was given up
/// (cancelled, abandoned); stop spending on it. The connection's answer is no longer read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ModelProxyCancelParams {
    pub request_id: RequestId,
}

/// Electron → its local core: stop the `modelProxy/run` run `run_id` (the abort of a
/// `model/proxy/cancel`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ModelProxyRunCancelParams {
    pub run_id: String,
}
