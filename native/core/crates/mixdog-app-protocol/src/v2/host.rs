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
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostClaimParams {
    pub host_id: HostId,
    /// Where the desktop keeps the server cores and the askpass helper the core launches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resources: Option<crate::v2::connections::HostClaimResources>,
    /// The `host/*` methods this claimant serves. Absent: every method of the capabilities declared in `capabilities.host`
    /// (the boolean routing); present: a request for a method not listed is not sent to this claimant (`unsupportedMethod`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serves: Option<Vec<String>>,
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
    WindowFocus(crate::v2::connections::WindowFocusValue),
}

impl HostStateSetParams {
    /// The section key and the value to publish under it.
    pub fn into_parts(self) -> (&'static str, JsonValue) {
        match self {
            Self::BrowserTabs(value) => ("browserTabs", value),
            Self::BrowserImport(value) => ("browserImport", value),
            Self::Visualize(value) => ("visualize", serde_json::to_value(value).unwrap_or_default()),
            Self::DisplayPreferences(value) => ("displayPreferences", value),
            Self::WindowFocus(value) => ("windowFocus", serde_json::to_value(value).unwrap_or_default()),
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

/// Params of `host/humanOnly/begin`: the desktop holds Computer Use for one human-only dialog (`withHumanOnlyApproval`); `label` names what for in the refusal, empty names nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostHumanOnlyBeginParams {
    pub label: String,
}

/// Result of `host/humanOnly/begin`, answered once the Computer Use operations already running ended; `holdId` ends the hold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostHumanOnlyBeginResult {
    pub hold_id: String,
}

/// Params of `host/humanOnly/end`: the dialog of hold `holdId` closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostHumanOnlyEndParams {
    pub hold_id: String,
}

/// Params of `host/browser/command` (core → host): a browser action on the pages of `threadId`, with its input. The host
/// answers with the action's result, which may carry the desktop's `BrowserCommandTiming` as `timing`, or fails it with the
/// JSON-RPC error -32000, whose message is already redacted and whose `data.timing` is the failed command's
/// `BrowserCommandTiming`. Both timings are diagnostics: the core writes them to its agent trace (`browser_timing` rows)
/// and never shows them to the model.
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

/// Params of `host/computer/capture` (core → host): the `capture` command exactly as the loopback bridge was
/// posted it (`computer-bridge/client.mjs`: the host command plus `session_id`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct HostComputerCaptureParams {
    pub command: JsonValue,
}

/// The image of a computer host reply: its media type and base64 bytes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostComputerImage {
    pub mime_type: String,
    pub data: String,
}

/// Result of `host/computer/capture`: the computer host's reply value (`{ text, image? }`), as the bridge's
/// `{ ok: true, value }` carried it. A command the host refused is a JSON-RPC error carrying the host's message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostComputerCaptureResult {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<HostComputerImage>,
}

/// Params of `host/computer/displays` (core → host): none.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct HostComputerDisplaysParams {}

/// One display of `host/computer/displays` (`computer/host/display-reads.ts` `readDisplays`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct HostComputerDisplay {
    pub index: u32,
    pub id: String,
    pub primary: bool,
    pub scale_factor: f64,
    pub width: u32,
    pub height: u32,
    /// The display's origin in native desktop coordinates (`nativeDisplayGeometry`, physical pixels on Windows and Linux).
    /// Absent from an older desktop's list: a display at 0,0.
    #[serde(default)]
    pub x: i32,
    #[serde(default)]
    pub y: i32,
    /// The OS's name for the display; absent from an older desktop's list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// What a `host/computer/foregroundLease` request does (`foreground-lock-host.ts` `LeaseThreadRequest`): `acquire` and
/// `release` relay a helper's `@@MIXDOG_FGLOCK@@` line; `gone` says the helper exited, so a lease it holds ends now
/// (`workerGone`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum HostComputerLeaseOp {
    Acquire,
    Release,
    Gone,
}

/// Params of `host/computer/foregroundLease` (core → host): one foreground-lock request of a Computer Use helper. Windows
/// lets only a process that may set the foreground take the lock, which while the user works in a Mixdog window is the
/// desktop, so the core relays the request there (`foreground-lock-host.ts` `handle`). A number the op does not use is 0.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostComputerForegroundLeaseParams {
    pub op: HostComputerLeaseOp,
    /// The helper that asks: the core's id for it, never reused (`LeaseWorker.instance`).
    pub instance: String,
    /// The helper's request in flight that asks, 1..2^31-1.
    pub action: u32,
    /// The ask's number within that request, 1..2^31-1.
    pub seq: u32,
    /// `acquire`: the longest the lock may be held, 1..1000 ms.
    pub hold_ms: u32,
    /// `acquire`: when the helper stops waiting for the answer, in ms on QueryPerformanceCounter.
    pub answer_by: f64,
    /// `release`: the lease it ends; 0 when the helper was told none.
    pub lease: u32,
}

/// How the desktop answered a `host/computer/foregroundLease`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum HostComputerLeaseReplyKind {
    Ack,
    Released,
    Unavailable,
}

/// Result of `host/computer/foregroundLease`, the reply lines of `foreground-lock-host.ts`: `ack` answers an `acquire`
/// (`ack <action> <seq> <lease> <answer> <deadline>` on the helper's stdin), `released` a `release`
/// (`released <action> <seq> <lease> <outcome>`); `unavailable` says no lease owner serves the desktop. A member the kind
/// does not carry is absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostComputerForegroundLeaseResult {
    pub kind: HostComputerLeaseReplyKind,
    /// `ack`, `unavailable`: `locked`, `refused`, `busy`, `quarantined`, `expired` or `unavailable`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    /// `ack`, `released`: the lease; 0 when none was taken.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease: Option<u32>,
    /// `ack`: when the lease ends, in ms on QueryPerformanceCounter; 0 when none was taken.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_at: Option<f64>,
    /// `released`: `released`, `unknown`, `failed` or `none`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    /// `unavailable`: why no lease owner answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The desktop's facts for the request (`takeFacts`), for the helper's `foreground_lock.host`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facts: Option<JsonValue>,
}

/// Params of `host/computer/internalWindows` (core → host): none.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct HostComputerInternalWindowsParams {}

/// Result of `host/computer/internalWindows`: the desktop's own Computer Use windows (overlay, pill, indicator), which no
/// window list may show (`overlay/internal-windows.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostComputerInternalWindowsResult {
    /// Their ids as the helper names windows (`hwnd:0x…`), matched without regard to case (`normalizedWindowId`).
    pub window_ids: Vec<String>,
}

/// Params of `host/computer/pointerFeedback` (core → host): a helper's pointer progress, which the overlay draws as the
/// agent's arrow. Each event is a `@@MIXDOG_POINTER@@` line the core checked against the request it belongs to
/// (`worker-pool.ts` `reportPointerProgress`). The host answers `null`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostComputerPointerFeedbackParams {
    pub session_id: ThreadId,
    /// In the helper's order, each with what `publishPointerProgress` takes: `x`, `y`, `held`, `phase`, `mode` and
    /// `windowId`.
    pub events: Vec<JsonValue>,
}

/// What the Computer Use pill asks of `computer/userControl`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ComputerUserControlAction {
    Resume,
    Stop,
    // The pause the pill takes when its control renderer dies (`takeOver('user_pause')`): a hold that only Resume ends and that
    // never tells a waiting model it was cancelled. A plain comment, so the schema stays a bare enum.
    Pause,
    // The user's hold taken for `reason` (Node's `takeOver(reason)`): a hold only Resume ends.
    Takeover,
    // Sets how long the user must be idle before a hold ends by itself (`params.seconds`, 0 = only Resume ends it).
    ConfigureIdleResume,
}

/// Params of `computer/userControl` (desktop → core): the pill's Resume or Stop of the user's hold on the desktop.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ComputerUserControlParams {
    pub action: ComputerUserControlAction,
    /// The session the pill acts for; absent: every session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_thread_id: Option<ThreadId>,
    /// `takeover` only: why the hold is taken. Checked by `ComputerUserControlParams::validate` (computer_host.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<crate::v2::computer_host::ComputerTakeoverReason>,
    /// `configureIdleResume` only, 0..=60.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<u32>,
}

/// Result of `computer/userControl`: whether the user's hold changed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct ComputerUserControlResult {
    pub ok: bool,
}

/// Params of `computer/bridge/run` (desktop -> core): one command of the loopback computer bridge, for the session it names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ComputerBridgeRunParams {
    /// The bridge's wire command (`ComputerCommand`): an object with `action` and the action's fields; `session_id`, `turn_id` and `runtime_id` ride in it.
    pub command: JsonValue,
    /// The session the command runs in (the bridge's `session_id`, `default` when it names none).
    pub session_key: String,
    /// Names this call for `computer/bridge/abort`.
    pub signal_id: String,
}

/// The image of a bridge reply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ComputerBridgeImage {
    /// Base64.
    pub data: String,
    /// `image/png` or `image/jpeg`.
    pub mime_type: String,
}

/// A bridge reply (`ComputerCommandResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ComputerBridgeValue {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ComputerBridgeImage>,
}

/// Result of `computer/bridge/run`: the bridge's own answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ComputerBridgeRunResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<ComputerBridgeValue>,
    /// The redacted message of why the command failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The HTTP status the bridge answers when it is not 200: 400 (invalid request) or 429 (the allowance of concurrent requests is spent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

/// Params of `computer/bridge/abort` (desktop -> core).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ComputerBridgeAbortParams {
    pub session_key: String,
    /// The call to end; absent: the whole session is aborted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal_id: Option<String>,
}

/// Result of `computer/bridge/abort`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ComputerBridgeAbortResult {
    /// False when a session abort's cleanup was not confirmed.
    pub ok: bool,
    /// How many running or queued calls were cancelled.
    pub cancelled: u32,
}

/// Params of `browser/bridge/run` (desktop -> core): one command of the loopback browser bridge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserBridgeRunParams {
    /// The bridge's wire command: an object with `action`, the action's fields, `session_id` (`browser` when absent), `turn_id` and the runtime-set `unattended_run`, `unattended_agent`, `session_life` and `mail_link`.
    pub command: JsonValue,
    /// Names this call for `browser/bridge/abort`.
    pub signal_id: String,
}

/// A bridge reply: what the browser command answered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserBridgeValue {
    pub text: String,
    /// The image of the reply (the same shape as a computer bridge reply's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ComputerBridgeImage>,
    /// `blocked` when the command ended inconclusively.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    /// The command's `BrowserCommandTiming`: diagnostics, never model text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing: Option<JsonValue>,
}

/// Result of `browser/bridge/run` and `browser/bridge/turn`: the bridge's own answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserBridgeRunResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<BrowserBridgeValue>,
    /// The redacted message of why the command failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The failed command's `BrowserCommandTiming`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing: Option<JsonValue>,
    /// The HTTP status the bridge answers when it is not 200: 400 (invalid request) or 429 (the allowance of concurrent commands is spent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

/// Which end of a turn `browser/bridge/turn` marks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserBridgeTurnPhase {
    Begin,
    Finish,
}

/// Params of `browser/bridge/turn` (desktop -> core).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserBridgeTurnParams {
    pub phase: BrowserBridgeTurnPhase,
    /// The session; `browser` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The runtime's turn number: a positive safe integer.
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub turn_id: u64,
    /// A turn that ended badly: its temporary pages are closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aborted: Option<bool>,
}

/// Params of `browser/bridge/abort` (desktop -> core).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserBridgeAbortParams {
    pub signal_id: String,
}

/// Result of `browser/bridge/abort`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserBridgeAbortResult {
    /// How many running commands were stopped.
    pub cancelled: u32,
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
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct UpdateDesktopCommandParams {
    pub op_id: mixdog_protocol::OpId,
    pub action: UpdaterAction,
    /// `install` only: the user confirmed installing past running agent tasks (Node's relay `showDesktopUpdate`
    /// argument, remote-methods.ts:1062-1063), passed on to the host as `host/update/command`'s `confirmed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed: Option<bool>,
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
    /// The server connection the notification is for (a server's notifier), so a click focuses that server's window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    /// The server's name, shown as the notification's source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// A subscriber change → `on` with the largest options of the session's subscribers, last subscriber gone → `off`
/// (SPEC §4.7.3; Node's `browserRemote('stream', [sessionId, options | null])`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostBrowserViewFramesParams {
    pub tab_id: String,
    /// The X17 `streamId` the host stamps on this tab's frames.
    pub stream_id: u32,
    pub on: bool,
    /// The largest `{maxWidth, maxHeight, fit?}` of the session's subscribers (Node's `largest`, `remote-browser-streams.ts`);
    /// `null` with `on: false`.
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
    /// The browser session a phone streams (`sessionId` of its `browser/stream`; the source
    /// `browser:<id>` of its live-view signals), as in `host/browser/viewFrames`.
    pub tab_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    /// `{generation, cssWidth, cssHeight, deviceScaleFactor, pixelWidth, pixelHeight}`.
    pub geometry: Option<JsonValue>,
}

/// Params of `browser/stream` (a phone's request, Node's `browserRemoteStream([sessionId, options])`): `on` starts or renews this
/// connection's subscription to the browser session with `request` (Node's `DesktopRemoteBrowserStreamOptions`
/// `{maxWidth, maxHeight, fit?}`, checked as `normalizeRemoteBrowserStreamOptions` checks it); `on: false` ends it (Node's `null`
/// options). A subscription lapses 4 s after its last renewal. On every change the core sends the host
/// `host/browser/viewFrames{on:true, request}` with the largest options of the session's subscribers, and `{on:false}` when the last
/// one ends; the phone's live-view signals name only a session it streams.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserStreamParams {
    pub session_id: String,
    pub on: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<JsonValue>,
}

/// `browser/streamAck` (phone → core notification, Node's `browserRemoteStreamAck([sessionId, seq])`): the phone painted the
/// `browser/frame` of `seq`, so its next (newest) frame of the session may go out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BrowserStreamAckParams {
    pub session_id: String,
    pub seq: f64,
}

/// The `browser/frame` push (Node's `browserRemoteFrame` event): its params are Node's payload itself, one frame of a session the
/// phone streams (`DesktopRemoteBrowserStreamFrame`: `frameId`, `sessionId`, `seq`, `documentId`, the page facts and, unless
/// withheld, `image` `{mimeType, data}` as base64), field for field and in the order Node's relay built it. At most one is
/// unacknowledged per subscription; the newest frame goes next, after the phone's `browser/streamAck` or 1.5 s.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(transparent)]
pub struct BrowserFrameParams(pub JsonValue);

/// `host/browser/frame` (host → core notification, Node's `browserRemoteFrame` desktop operation): a frame of a viewed
/// session (`DesktopRemoteBrowserStreamFrame`) without its picture bytes. When `frame.image` is present (`{mimeType:
/// "image/jpeg"}`, no `data`), the picture is the next X17 frame of the session's stream on the same connection, and the
/// core sends the frame once it has the picture; a frame without `image` carries facts only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostBrowserFrameParams {
    /// The session, as in `host/browser/viewFrames`.
    pub tab_id: String,
    pub frame: JsonValue,
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
    /// The server connection the clicked notification was for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub connection_id: Option<String>,
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
    /// Absent only from a paired phone stating one of the other fields alone (Node's `setForeground` or `setVisualizePanels`):
    /// its last set stays. A UI's notification without it changes nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visualize_session_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<bool>,
}

/// Client notification `remote/connectionTimeline` (paired phone → core): the phone's own account of a slow reconnect (phase,
/// state and issue tokens with ms offsets), Node's `reportConnectionTimeline`. The core writes it to its log as Node's PC did
/// (`remote-relay-client-calls.ts:181-186`): the first 1500 UTF-16 units, without any character outside `[A-Za-z0-9_=@:. -]`, as
/// `[mixdog-remote-timeline] client=<the relay client id's first 8 units> <text>`, nothing when that leaves no text. Only an
/// attached relay connection is heard. No response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct RemoteConnectionTimelineParams {
    pub text: String,
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
