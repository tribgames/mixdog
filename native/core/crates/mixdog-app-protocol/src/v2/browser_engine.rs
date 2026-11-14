//! The browser engine host lane (`host/browser/*`): the core drives the pages of the desktop's
//! guest views through typed requests and learns of their state through ordered notifications.
//! A host declares `capabilities.host.browserEngine` to serve it; one that does not keeps the
//! `host/browser/command` forward path. Every mutating request carries an `expect`
//! [`Precondition`] the host checks synchronously right before the CDP send, and every result
//! carries the page's [`PageFacts`] with their `seq`.
//!
//! Failures are JSON-RPC errors whose `data` carries the facts the code needs
//! (`BROWSER_ENGINE_ERR_*`); `-32000` is a plain failure with a redacted message.
//!
//! The requests never carry a `threadId`: they are core to host and addressed by page or
//! session, and none is an offered request (a client never answers them for another host).

use std::collections::BTreeMap;

use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use serde::Deserialize;
use serde::Serialize;

/// `data.code` of a refused precondition (`BrowserPreconditionFailedData`).
pub const BROWSER_ENGINE_ERR_PRECONDITION_FAILED: i32 = -32010;
/// The page is gone (closed, crashed beyond recovery, or its session ended).
pub const BROWSER_ENGINE_ERR_PAGE_GONE: i32 = -32011;
/// The person holds the page (`BrowserUserInputErrorData`).
pub const BROWSER_ENGINE_ERR_USER_INPUT: i32 = -32012;
/// The snapshot the call named is no longer the page's current one.
pub const BROWSER_ENGINE_ERR_STALE_SNAPSHOT: i32 = -32013;
/// A dialog blocks the page (`BrowserDialogBlockingData`).
pub const BROWSER_ENGINE_ERR_DIALOG_BLOCKING: i32 = -32014;
/// Refused by the URL policy or the CDP allowlist (`BrowserRefusedErrorData`).
pub const BROWSER_ENGINE_ERR_REFUSED: i32 = -32015;
/// A failure whose message the host already redacted.
pub const BROWSER_ENGINE_ERR_FAILED: i32 = -32000;

/// The CDP events a host forwards in `host/browser/events`; the rest never leave the host.
/// `Mixdog.internalConsole {level, text}` and `Mixdog.requestRefused {url, reason}` are synthetic.
pub const BROWSER_ENGINE_EVENT_METHODS: &[&str] = &[
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Network.loadingFinished",
    "Network.loadingFailed",
    "Network.requestServedFromCache",
    "Network.dataReceived",
    "Network.webSocketCreated",
    "Network.webSocketClosed",
    "Network.webSocketFrameError",
    "Network.requestWillBeSentExtraInfo",
    "Network.responseReceivedExtraInfo",
    "Runtime.consoleAPICalled",
    "Runtime.exceptionThrown",
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
    "Log.entryAdded",
    "Page.javascriptDialogOpening",
    "Page.javascriptDialogClosed",
    "Page.fileChooserOpened",
    "Mixdog.internalConsole",
    "Mixdog.requestRefused",
];

/// The CDP methods `host/browser/cdp/send` refuses with `-32015`: the host owns these domains or methods itself.
pub const BROWSER_ENGINE_CDP_REFUSED: &[&str] = &[
    "Accessibility.getFullAXTree",
    "DOMSnapshot.",
    "Tracing.",
    "Fetch.",
    "Target.",
    "Debugger.",
    "Browser.",
    "Emulation.",
    "Input.",
    "Page.addScriptToEvaluateOnNewDocument",
];

/// Whether `host/browser/cdp/send` refuses `method`.
pub fn browser_engine_cdp_refused(method: &str) -> bool {
    BROWSER_ENGINE_CDP_REFUSED.iter().any(|refused| method.starts_with(refused))
}

/// The page state a mutating call was decided against; the host checks it synchronously right before the CDP send and refuses with -32010 when it no longer holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct Precondition {
    pub document_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_sessions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
}

/// A frame of a page: a child session and/or a frame id; absent means the main frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct FrameRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserChildSession {
    pub session_id: String,
    pub frame_id: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserRefusedRequest {
    pub url: String,
    pub reason: String,
}

/// A JavaScript dialog the page is blocked on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserPendingDialog {
    #[serde(rename = "type")]
    #[cfg_attr(feature = "codegen", ts(rename = "type"))]
    pub kind: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_prompt: Option<String>,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub opened_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The dialog belongs to the bridge's own page, not the person's.
    pub bridge: bool,
}

/// The last dialog the host dismissed by itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserDismissedDialog {
    #[serde(rename = "type")]
    #[cfg_attr(feature = "codegen", ts(rename = "type"))]
    pub kind: String,
    pub message: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserPendingFileChooser {
    pub mode: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub opened_at: i64,
    pub receiver_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserPageActor {
    Agent,
    Person,
}

/// Everything the core needs to know about a page's state; `seq` rises with every change the host reports, so a gap is a lost event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct PageFacts {
    pub page_id: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub seq: u64,
    pub document_id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub main_frame_loading: bool,
    pub alive: bool,
    pub crashed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fault: Option<String>,
    pub background: bool,
    pub visible: bool,
    pub zoom: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_dialog: Option<BrowserPendingDialog>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismissed_dialog: Option<BrowserDismissedDialog>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_file_chooser: Option<BrowserPendingFileChooser>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<BrowserPageActor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub user_input_at: Option<i64>,
    pub child_sessions: Vec<BrowserChildSession>,
    /// The page ids of popups this page opened.
    pub opened_popups: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused_requests: Option<Vec<BrowserRefusedRequest>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct PageDescriptor {
    pub page_id: String,
    pub tab_id: String,
    pub session_id: String,
    pub background: bool,
    pub facts: PageFacts,
}

/// A payload too large for the response, left in the host's blob store and read by digest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserBlobRef {
    pub digest: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub size: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserExceptionDetails {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserSnapshotElement {
    #[serde(rename = "ref")]
    #[cfg_attr(feature = "codegen", ts(rename = "ref"))]
    pub ref_id: String,
    pub role: String,
    pub name: String,
    pub tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sensitive: Option<bool>,
    /// A secret field that holds a value (never shown); an empty one has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub states: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_viewport: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_field: Option<String>,
}

/// The shape of `browser/accessibility.ts` `BrowserSnapshotPayload`, moved here as a schema type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserSnapshotPayload {
    pub snapshot_id: String,
    pub url: String,
    pub title: String,
    pub scroll_y: f64,
    pub scroll_height: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
    pub elements: Vec<BrowserSnapshotElement>,
    pub total_elements: u32,
    pub scanned: u32,
    pub scan_capped: bool,
    pub cross_origin_frames: u32,
    pub headings: Vec<String>,
    pub text: String,
    /// The page holds more text than this excerpt carries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_clipped: Option<bool>,
    pub query: String,
    /// Interactive elements on the page before the query filter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unfiltered_elements: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
}

/// One intercept rule (`browser/intercept.ts` `BrowserInterceptRule`); `id` and `hits` are the host's, absent on an `add`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct InterceptRule {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub pattern: String,
    #[serde(default)]
    pub resource_types: Vec<String>,
    #[serde(default)]
    pub abort: bool,
    #[serde(default)]
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hits: Option<u32>,
}

/// The overrides of the `emulate` command (`browser/emulation-validation.ts`); the host merges them with the pane viewport.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct EmulationSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_scale_factor: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mobile: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub touch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_scheme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reduced_motion: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_throttling_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latitude: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub longitude: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accuracy: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
}

/// One tracked download (`browser/downloads.ts` `TrackedBrowserDownload`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct DownloadItem {
    pub id: String,
    pub file: String,
    pub path: String,
    pub url: String,
    pub mime_type: String,
    pub state: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub received: i64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub total: i64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserApprovalRememberKind {
    Submit,
    Post,
    Upload,
    Confirm,
}

/// A standing "always allow" may be recorded for these kinds of step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserApprovalRemember {
    pub kinds: Vec<BrowserApprovalRememberKind>,
    /// Always `true` when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "true"))]
    pub session: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserApprovalFile {
    pub name: String,
    pub path: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub size: i64,
    /// Beyond the session's working directory and Downloads.
    pub outside: bool,
}

/// The card of a Browser Use submit, post or upload awaiting the person (`DesktopBrowserApprovalPrompt`, shared/contract.ts).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserApprovalPrompt {
    pub id: String,
    pub action: String,
    pub url: String,
    pub session_id: String,
    /// The top-level chat the card docks in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_session_id: Option<String>,
    /// The bot whose own chat asks; absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// The asking bot's or session's name; empty when it could not be resolved.
    pub requester: String,
    pub target: String,
    pub paths: Vec<String>,
    /// Upload only: the page's origin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// Upload only: the origin of the frame document that receives the files; empty = not confirmed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<BrowserApprovalFile>>,
    /// `null` = the step only asks once.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = false))]
    pub remember: Option<BrowserApprovalRemember>,
    /// The page holds payment fields: this step asks once, every time. Always `true` when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "true"))]
    pub payment: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserPreconditionReason {
    Document,
    Origin,
    Url,
    ChildSession,
    Receiver,
    Snapshot,
}

/// `data` of the -32010 error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserPreconditionFailedData {
    pub reason: BrowserPreconditionReason,
    pub facts: PageFacts,
}

/// `data` of the -32012 error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserUserInputErrorData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub until: Option<i64>,
}

/// `data` of the -32014 error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserDialogBlockingData {
    pub dialog: BrowserPendingDialog,
}

/// `data` of the -32015 error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserRefusedErrorData {
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserTabSelector {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserOpenSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub reveal: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserLeaseSpec {
    pub command_id: String,
    pub ttl_ms: u32,
}

/// `host/browser/pages/resolve` (core to host): the page a session's command works on, opened or adopted when needed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPagesResolveParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<BrowserTabSelector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open: Option<BrowserOpenSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adopt: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease: Option<BrowserLeaseSpec>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPagesResolveResult {
    pub page: PageDescriptor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<String>,
}

/// `host/browser/pages/list`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPagesListParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPagesListResult {
    pub pages: Vec<PageDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_page_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserPageCloseReason {
    Agent,
    TurnEnd,
    Idle,
}

/// `host/browser/pages/close`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPagesCloseParams {
    pub page_id: String,
    pub reason: BrowserPageCloseReason,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPagesCloseResult {
    pub closed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_active_page_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserSurfaceOp {
    Reveal,
    Hide,
    Handoff,
}

/// `host/browser/pages/surface`: show, hide or hand off the pane (the host also sends `host/browser/surface`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPagesSurfaceParams {
    pub session_id: String,
    pub op: BrowserSurfaceOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPagesSurfaceResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facts: Option<PageFacts>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserNavigateKind {
    Url,
    Reload,
    Back,
    Forward,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserMailLink {
    pub url: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub expires_at: i64,
}

/// `host/browser/page/navigate`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageNavigateParams {
    pub page_id: String,
    pub kind: BrowserNavigateKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail_link: Option<BrowserMailLink>,
    pub expect: Precondition,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserNavigateRefusal {
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageNavigateResult {
    pub facts: PageFacts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<BrowserNavigateRefusal>,
}

/// `host/browser/page/stop`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageStopParams {
    pub page_id: String,
}

/// The result of every call that answers with the page's facts alone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageFactsResult {
    pub facts: PageFacts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserEvalWorld {
    Main,
    Utility,
}

/// `host/browser/page/eval`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageEvalParams {
    pub page_id: String,
    pub expression: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<FrameRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub await_promise: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_by_value: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub world: Option<BrowserEvalWorld>,
    pub timeout_ms: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect: Option<Precondition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageEvalResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exception: Option<BrowserExceptionDetails>,
    pub facts: PageFacts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserPageReadKind {
    Text,
    Documents,
    Frames,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserPageReadOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<FrameRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_hidden: Option<bool>,
}

/// `host/browser/page/read`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageReadParams {
    pub page_id: String,
    pub kind: BrowserPageReadKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<BrowserPageReadOptions>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageReadResult {
    pub payload: JsonValue,
    pub truncated: bool,
    pub facts: PageFacts,
}

/// `host/browser/page/renderCheckpoint`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageRenderCheckpointParams {
    pub page_id: String,
    pub timeout_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageRenderCheckpointResult {
    pub reached: bool,
    pub facts: PageFacts,
}

/// `host/browser/page/domQuiet`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageDomQuietParams {
    pub page_id: String,
    pub quiet_ms: u32,
    pub timeout_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageDomQuietResult {
    pub quiet: bool,
    pub mutations: u32,
    pub facts: PageFacts,
}

/// `host/browser/page/dialog/answer`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageDialogAnswerParams {
    pub page_id: String,
    pub accept: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_text: Option<String>,
    pub expect: Precondition,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageDialogAnswerResult {
    pub answered: bool,
    pub facts: PageFacts,
}

/// `host/browser/page/sync`: resync after a seq gap.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageSyncParams {
    pub page_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageSyncResult {
    pub facts: PageFacts,
    /// The console ledger's floor; the core resets its cursors to it.
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub console_floor: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserSnapshotMode {
    Full,
    Interactive,
    Query,
    Viewport,
}

/// `host/browser/snapshot`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserSnapshotParams {
    pub page_id: String,
    pub mode: BrowserSnapshotMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_elements: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_chars: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<FrameRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserSnapshotResult {
    pub snapshot_id: String,
    pub document_id: String,
    pub revision: u32,
    pub payload: BrowserSnapshotPayload,
    pub warnings: Vec<String>,
    pub facts: PageFacts,
}

/// `host/browser/ref/call`: a function called on the element a snapshot ref names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserRefCallParams {
    pub page_id: String,
    pub snapshot_id: String,
    #[serde(rename = "ref")]
    #[cfg_attr(feature = "codegen", ts(rename = "ref"))]
    pub ref_id: String,
    pub function_declaration: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<JsonValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_by_value: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect: Option<Precondition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserRefCallResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exception: Option<BrowserExceptionDetails>,
    pub facts: PageFacts,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserHitGuard {
    pub snapshot_id: String,
    #[serde(rename = "ref")]
    #[cfg_attr(feature = "codegen", ts(rename = "ref"))]
    pub ref_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserPointerKind {
    Move,
    Click,
    Dblclick,
    Hover,
    Down,
    Up,
    Wheel,
    Tap,
    DragTo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserPointerButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserTypeStep {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserInsertTextStep {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserPressStep {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserPointerStep {
    pub kind: BrowserPointerKind,
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<BrowserPointerButton>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hit_guard: Option<BrowserHitGuard>,
}

/// `host/browser/input/batch`: the steps run in order; the batch stops at a dialog.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserInputBatchParams {
    pub page_id: String,
    pub steps: Vec<InputStep>,
    pub stop_on_dialog: bool,
    pub timeout_ms: u32,
    pub expect: Precondition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserInputOutcome {
    Completed,
    Dialog,
    Cancelled,
    UserInput,
    HitGuard,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserInputTiming {
    pub input_ms: f64,
    pub key_events: u32,
    pub mouse_events: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserInputBatchResult {
    pub outcome: BrowserInputOutcome,
    pub completed_steps: u32,
    pub timing: BrowserInputTiming,
    pub facts: PageFacts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserImageFormat {
    Png,
    Jpeg,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserClipRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserClipRef {
    pub snapshot_id: String,
    #[serde(rename = "ref")]
    #[cfg_attr(feature = "codegen", ts(rename = "ref"))]
    pub ref_id: String,
}

/// `host/browser/screenshot`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserScreenshotParams {
    pub page_id: String,
    pub format: BrowserImageFormat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_page: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip: Option<BrowserScreenshotClip>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserScreenshotResult {
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    /// Base64, only when the encoded picture is 128 KiB or less.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<BrowserBlobRef>,
    pub facts: PageFacts,
}

/// `host/browser/cdp/send`: refused with -32015 for the methods in `BROWSER_ENGINE_CDP_REFUSED`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserCdpSendParams {
    pub page_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect: Option<Precondition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserCdpSendResult {
    pub result: JsonValue,
    pub facts: PageFacts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserCookiesOp {
    Get,
    Set,
    Delete,
    Clear,
}

/// `host/browser/cookies`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserCookiesParams {
    pub page_id: String,
    pub op: BrowserCookiesOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub urls: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cookie: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserCookiesResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cookies: Option<Vec<JsonValue>>,
    pub facts: PageFacts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserStorageOp {
    Get,
    Set,
    Remove,
    Clear,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserStorageArea {
    Local,
    Session,
}

/// `host/browser/storage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserStorageParams {
    pub page_id: String,
    pub op: BrowserStorageOp,
    pub area: BrowserStorageArea,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserStorageResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entries: Option<JsonValue>,
    pub facts: PageFacts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserListOp {
    Add,
    Remove,
    List,
}

/// `host/browser/initScripts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserInitScriptsParams {
    pub page_id: String,
    pub op: BrowserListOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserInitScript {
    pub id: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserInitScriptsResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scripts: Option<Vec<BrowserInitScript>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserInterceptOp {
    Add,
    Remove,
    List,
    Clear,
}

/// `host/browser/intercept`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserInterceptParams {
    pub page_id: String,
    pub op: BrowserInterceptOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<InterceptRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserInterceptResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<InterceptRule>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserPerformanceOp {
    Start,
    Stop,
    Metrics,
}

/// `host/browser/performance`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPerformanceParams {
    pub page_id: String,
    pub op: BrowserPerformanceOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPerformanceResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported_to: Option<String>,
}

/// `host/browser/emulation`: `overrides: null` clears them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserEmulationParams {
    pub page_id: String,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = false))]
    pub overrides: Option<EmulationSpec>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserEmulationResult {
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = false))]
    pub applied: Option<EmulationSpec>,
    pub facts: PageFacts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserDownloadsOp {
    List,
    Take,
}

/// `host/browser/downloads`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserDownloadsParams {
    pub session_id: String,
    pub op: BrowserDownloadsOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub since: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserDownloadsResult {
    pub items: Vec<DownloadItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<BrowserBlobRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserUploadRoute {
    FileInput,
    Chooser,
    Drop,
    PickerClick,
}

/// `host/browser/upload`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserUploadParams {
    pub page_id: String,
    pub route: BrowserUploadRoute,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "ref")]
    #[cfg_attr(feature = "codegen", ts(rename = "ref"))]
    pub ref_id: Option<String>,
    pub files: Vec<String>,
    pub receiver_key: String,
    pub expect: Precondition,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserUploadReceiver {
    pub tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiple: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserUploadResult {
    pub dispatched: bool,
    pub verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver: Option<BrowserUploadReceiver>,
    pub facts: PageFacts,
}

/// `host/browser/lease/release` (core to host notification): the lease on a page ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserLeaseReleaseParams {
    pub page_id: String,
    pub lease_id: String,
}

/// One CDP event of the allowlist (`BROWSER_ENGINE_EVENT_METHODS`), or a synthetic `Mixdog.*` one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserEngineEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub method: String,
    pub params: JsonValue,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub t: i64,
}

/// `host/browser/events` (host to core notification): ordered with the page's other notifications on the same writer; a batch stays under 200 KiB serialized.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserEventsParams {
    pub page_id: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub seq: u64,
    pub events: Vec<BrowserEngineEvent>,
}

/// `host/browser/page/facts` (host to core notification).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserPageFactsParams {
    pub page_id: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub seq: u64,
    pub facts: PageFacts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserUserInputReason {
    Pointer,
    Key,
    Dialog,
    Takeover,
    FilePicker,
}

/// `host/browser/userInput` (host to core notification): the person holds the page, or lets go.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostBrowserUserInputParams {
    pub page_id: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub seq: u64,
    pub held: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub until: Option<i64>,
    pub reason: BrowserUserInputReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BrowserTestTool {
    Browser,
    #[serde(rename = "browser_devtools")]
    #[cfg_attr(feature = "codegen", ts(rename = "browser_devtools"))]
    BrowserDevtools,
}

/// `test/browserEngine/run`: one tool call run through the engine. Registered only when mixdogd starts with MIXDOGD_TEST_HOOKS=1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserEngineTestRunParams {
    pub thread_id: ThreadId,
    pub tool: BrowserTestTool,
    pub args: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserTestRunImage {
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct BrowserEngineTestRunResult {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<BrowserTestRunImage>,
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<JsonValue>,
}

/// One step of `host/browser/input/batch`, by `op`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "op")]
pub enum InputStep {
    #[serde(rename = "type")]
    #[cfg_attr(feature = "codegen", ts(rename = "type"))]
    Type(BrowserTypeStep),
    #[serde(rename = "insertText")]
    #[cfg_attr(feature = "codegen", ts(rename = "insertText"))]
    InsertText(BrowserInsertTextStep),
    #[serde(rename = "press")]
    #[cfg_attr(feature = "codegen", ts(rename = "press"))]
    Press(BrowserPressStep),
    #[serde(rename = "pointer")]
    #[cfg_attr(feature = "codegen", ts(rename = "pointer"))]
    Pointer(BrowserPointerStep),
}

/// The region a screenshot is cut to: an element a snapshot ref names, or a rectangle in CSS pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(untagged)]
pub enum BrowserScreenshotClip {
    Ref(BrowserClipRef),
    Rect(BrowserClipRect),
}

/// `capabilities.host.browserEngine`: this host serves the `host/browser/*` engine lane. `features` names optional parts of
/// version 1 the host implements; a host that omits the capability gets the `host/browser/command` forward path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BrowserEngineCapability {
    pub version: u32,
    #[serde(default)]
    pub features: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn facts_json() -> JsonValue {
        json!({
            "pageId": "p1", "seq": 7, "documentId": "d1", "url": "https://a.test/", "title": "A",
            "loading": false, "mainFrameLoading": false, "alive": true, "crashed": false,
            "background": false, "visible": true, "zoom": 1.0, "childSessions": [], "openedPopups": []
        })
    }

    #[test]
    fn page_facts_use_camel_case_and_skip_absent_fields() {
        let facts: PageFacts = serde_json::from_value(facts_json()).unwrap();
        assert_eq!((facts.seq, facts.page_id.as_str()), (7, "p1"));
        assert_eq!(serde_json::to_value(&facts).unwrap(), facts_json());
    }

    #[test]
    fn pending_dialog_keeps_its_type_key() {
        let dialog: BrowserPendingDialog = serde_json::from_value(json!({
            "type": "prompt", "message": "m", "defaultPrompt": "d", "openedAt": 5, "bridge": false
        }))
        .unwrap();
        assert_eq!(dialog.kind, "prompt");
        assert_eq!(serde_json::to_value(&dialog).unwrap()["type"], "prompt");
    }

    #[test]
    fn precondition_skips_what_it_does_not_check() {
        let expect = Precondition {
            document_id: "d".into(),
            origin: None,
            url: Some("https://a.test/".into()),
            child_sessions: None,
            receiver_key: None,
            snapshot_id: None,
        };
        assert_eq!(serde_json::to_value(&expect).unwrap(), json!({"documentId": "d", "url": "https://a.test/"}));
    }

    #[test]
    fn input_steps_are_tagged_by_op() {
        let steps: Vec<InputStep> = serde_json::from_value(json!([
            {"op": "type", "text": "hi", "delayMs": 5},
            {"op": "insertText", "text": "x"},
            {"op": "press", "key": "Enter", "modifiers": ["Control"], "repeat": 2},
            {"op": "pointer", "kind": "dragTo", "x": 1.0, "y": 2.0, "toX": 3.0, "toY": 4.0, "button": "left",
             "hitGuard": {"snapshotId": "s", "ref": "e1"}},
            {"op": "pointer", "kind": "dblclick", "x": 1.0, "y": 2.0}
        ]))
        .unwrap();
        assert!(matches!(&steps[0], InputStep::Type(step) if step.delay_ms == Some(5)));
        assert!(matches!(&steps[2], InputStep::Press(step) if step.repeat == Some(2)));
        match &steps[3] {
            InputStep::Pointer(step) => {
                assert_eq!(step.kind, BrowserPointerKind::DragTo);
                assert_eq!(step.hit_guard.as_ref().map(|guard| guard.ref_id.as_str()), Some("e1"));
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(&steps[4], InputStep::Pointer(step) if step.kind == BrowserPointerKind::Dblclick));
        let back = serde_json::to_value(&steps[3]).unwrap();
        assert_eq!(back["op"], "pointer");
        assert_eq!(back["hitGuard"]["ref"], "e1");
    }

    #[test]
    fn unknown_input_op_is_refused() {
        assert!(serde_json::from_value::<InputStep>(json!({"op": "drag", "x": 1})).is_err());
    }

    #[test]
    fn screenshot_clip_is_a_ref_or_a_rectangle() {
        let by_ref: BrowserScreenshotClip = serde_json::from_value(json!({"snapshotId": "s", "ref": "e2"})).unwrap();
        assert!(matches!(by_ref, BrowserScreenshotClip::Ref(clip) if clip.ref_id == "e2"));
        let rect: BrowserScreenshotClip = serde_json::from_value(json!({"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0})).unwrap();
        assert!(matches!(rect, BrowserScreenshotClip::Rect(clip) if clip.width == 3.0));
        assert!(serde_json::from_value::<BrowserScreenshotClip>(json!({"x": 1.0})).is_err());
    }

    #[test]
    fn emulation_overrides_are_written_as_null_when_cleared() {
        let params = HostBrowserEmulationParams { page_id: "p".into(), overrides: None };
        assert_eq!(serde_json::to_value(&params).unwrap(), json!({"pageId": "p", "overrides": null}));
        let result: HostBrowserEmulationResult = serde_json::from_value(json!({"applied": null, "facts": facts_json()})).unwrap();
        assert_eq!(result.applied, None);
        let spec: EmulationSpec = serde_json::from_value(json!({
            "width": 390.0, "height": 844.0, "deviceScaleFactor": 3.0, "mobile": true, "headers": {"x-a": "b"}
        }))
        .unwrap();
        assert_eq!(spec.headers.as_ref().and_then(|headers| headers.get("x-a")).map(String::as_str), Some("b"));
        assert_eq!(serde_json::to_value(&spec).unwrap()["deviceScaleFactor"], 3.0);
    }

    #[test]
    fn intercept_rule_defaults_what_an_add_leaves_out() {
        let rule: InterceptRule = serde_json::from_value(json!({"pattern": "*/api/*", "abort": true})).unwrap();
        assert_eq!((rule.id, rule.hits, rule.abort, rule.body.as_str()), (None, None, true, ""));
        assert!(rule.resource_types.is_empty());
    }

    #[test]
    fn snapshot_payload_names_a_ref_key() {
        let element: BrowserSnapshotElement = serde_json::from_value(json!({
            "ref": "e3", "role": "button", "name": "Go", "tag": "button", "inViewport": true
        }))
        .unwrap();
        assert_eq!((element.ref_id.as_str(), element.in_viewport), ("e3", Some(true)));
        assert_eq!(serde_json::to_value(&element).unwrap()["ref"], "e3");
    }

    #[test]
    fn approval_prompt_always_writes_remember() {
        let prompt: BrowserApprovalPrompt = serde_json::from_value(json!({
            "id": "a", "action": "submit", "url": "https://a.test/", "sessionId": "s", "requester": "",
            "target": "form", "paths": [], "remember": null
        }))
        .unwrap();
        assert_eq!(prompt.remember, None);
        let written = serde_json::to_value(&prompt).unwrap();
        assert_eq!(written["remember"], JsonValue::Null);
        assert!(written.get("payment").is_none());
        let remembered: BrowserApprovalPrompt = serde_json::from_value(json!({
            "id": "a", "action": "upload", "url": "u", "sessionId": "s", "requester": "r", "target": "t", "paths": ["p"],
            "remember": {"kinds": ["submit", "upload"], "session": true}, "payment": true,
            "files": [{"name": "n", "path": "p", "size": 3, "outside": true}]
        }))
        .unwrap();
        assert_eq!(remembered.remember.map(|remember| remember.kinds.len()), Some(2));
    }

    #[test]
    fn results_and_params_keep_their_wire_names() {
        let params: HostBrowserPagesResolveParams = serde_json::from_value(json!({
            "sessionId": "s", "tab": {"pageId": "p"}, "open": {"url": "https://a.test/", "reveal": true},
            "lease": {"commandId": "c", "ttlMs": 5000}
        }))
        .unwrap();
        assert_eq!(params.lease.map(|lease| lease.ttl_ms), Some(5000));
        let batch: HostBrowserInputBatchResult = serde_json::from_value(json!({
            "outcome": "userInput", "completedSteps": 2, "timing": {"inputMs": 1.5, "keyEvents": 2, "mouseEvents": 0},
            "facts": facts_json()
        }))
        .unwrap();
        assert_eq!(batch.outcome, BrowserInputOutcome::UserInput);
        let route: BrowserUploadRoute = serde_json::from_value(json!("pickerClick")).unwrap();
        assert_eq!(route, BrowserUploadRoute::PickerClick);
        assert_eq!(serde_json::to_value(BrowserPreconditionReason::ChildSession).unwrap(), json!("childSession"));
        assert_eq!(serde_json::to_value(BrowserUserInputReason::FilePicker).unwrap(), json!("filePicker"));
    }

    #[test]
    fn notifications_carry_page_id_and_seq() {
        let events: HostBrowserEventsParams = serde_json::from_value(json!({
            "pageId": "p", "seq": 9,
            "events": [{"sessionId": "c1", "method": "Log.entryAdded", "params": {"entry": {}}, "t": 1000}]
        }))
        .unwrap();
        assert_eq!((events.seq, events.events.len()), (9, 1));
        let input: HostBrowserUserInputParams =
            serde_json::from_value(json!({"pageId": "p", "seq": 1, "held": true, "until": 5, "reason": "takeover"})).unwrap();
        assert_eq!(input.reason, BrowserUserInputReason::Takeover);
        let release = HostBrowserLeaseReleaseParams { page_id: "p".into(), lease_id: "l".into() };
        assert_eq!(serde_json::to_value(&release).unwrap(), json!({"pageId": "p", "leaseId": "l"}));
    }

    #[test]
    fn test_hook_params_name_the_tool() {
        let params: BrowserEngineTestRunParams =
            serde_json::from_value(json!({"threadId": "t1", "tool": "browser_devtools", "args": {"action": "x"}})).unwrap();
        assert_eq!(params.tool, BrowserTestTool::BrowserDevtools);
        assert_eq!(serde_json::to_value(BrowserTestTool::Browser).unwrap(), json!("browser"));
        let result: BrowserEngineTestRunResult = serde_json::from_value(json!({"text": "ok", "isError": false})).unwrap();
        assert!(!result.is_error && result.image.is_none());
    }

    #[test]
    fn capability_reads_without_features() {
        let capability: BrowserEngineCapability = serde_json::from_value(json!({"version": 1})).unwrap();
        assert_eq!((capability.version, capability.features.len()), (1, 0));
        assert_eq!(
            serde_json::to_value(BrowserEngineCapability { version: 1, features: vec!["upload".into()] }).unwrap(),
            json!({"version": 1, "features": ["upload"]})
        );
    }

    #[test]
    fn error_codes_and_allowlists() {
        assert_eq!(
            [
                BROWSER_ENGINE_ERR_PRECONDITION_FAILED,
                BROWSER_ENGINE_ERR_PAGE_GONE,
                BROWSER_ENGINE_ERR_USER_INPUT,
                BROWSER_ENGINE_ERR_STALE_SNAPSHOT,
                BROWSER_ENGINE_ERR_DIALOG_BLOCKING,
                BROWSER_ENGINE_ERR_REFUSED,
                BROWSER_ENGINE_ERR_FAILED,
            ],
            [-32010, -32011, -32012, -32013, -32014, -32015, -32000]
        );
        for refused in [
            "Accessibility.getFullAXTree",
            "DOMSnapshot.captureSnapshot",
            "Tracing.start",
            "Fetch.enable",
            "Target.attachToTarget",
            "Debugger.pause",
            "Browser.close",
            "Emulation.setDeviceMetricsOverride",
            "Input.dispatchKeyEvent",
            "Page.addScriptToEvaluateOnNewDocument",
        ] {
            assert!(browser_engine_cdp_refused(refused), "{refused}");
        }
        for allowed in ["Runtime.evaluate", "DOM.getDocument", "Accessibility.getPartialAXTree", "Page.navigate"] {
            assert!(!browser_engine_cdp_refused(allowed), "{allowed}");
        }
        let mut methods = BROWSER_ENGINE_EVENT_METHODS.to_vec();
        methods.sort_unstable();
        methods.dedup();
        assert_eq!(methods.len(), BROWSER_ENGINE_EVENT_METHODS.len());
        assert!(BROWSER_ENGINE_EVENT_METHODS.contains(&"Page.fileChooserOpened"));
    }
}
