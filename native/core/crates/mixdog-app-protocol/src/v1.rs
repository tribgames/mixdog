//! `initialize` / `initialized` (P §4.4, X4, X16).

use mixdog_protocol::ConnectionKind;
use serde::Deserialize;
use serde::Serialize;

use crate::common::Origin;
use crate::limits::Limits;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ClientInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Must equal the core's `serverVersion` (version gate, no ranges).
    pub version: String,
    pub kind: ConnectionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
}

/// The desktop host role (DS §12.2): what this connection serves for the core.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostCapabilities {
    /// In-app browser: `host/browser/command`, `item/browser/requestApproval` presentation.
    #[serde(default)]
    pub browser: bool,
    #[serde(default)]
    pub visualize: bool,
    /// OS toast and sound: `host/notification/show`.
    #[serde(default)]
    pub notifications: bool,
    /// `host/systemProxy/resolve`.
    #[serde(default)]
    pub system_proxy: bool,
    /// Sends `host/power`.
    #[serde(default)]
    pub power: bool,
    /// May send X17 binary media frames.
    #[serde(default)]
    pub media: bool,
    /// Desktop updater: `host/update/command`, sends `host/update/report`.
    #[serde(default)]
    pub updater: bool,
    /// File snapshots and the local page server.
    #[serde(default)]
    pub files: bool,
    /// Computer Use screen reads: `host/computer/capture`, `host/computer/displays`.
    #[serde(default)]
    pub computer: bool,
    /// Window objects of the desktop: `host/window/open`, `host/window/close`, `host/window/focus`; sends `host/window/closed`.
    #[serde(default)]
    pub windows: bool,
    /// The browser engine lane (`host/browser/*`, version 1); absent = the `host/browser/command` forward path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub browser_engine: Option<crate::v2::browser_engine::BrowserEngineCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct InitializeCapabilities {
    /// Exact notification methods suppressed for this connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opt_out_notification_methods: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub experimental_api: Option<bool>,
    /// Receive every pending approval request even without a thread subscription (P §8.3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_inbox: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<HostCapabilities>,
    /// Executes `model/proxy/execute` with this machine's accounts (DS §12.4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_proxy: Option<bool>,
    /// Folds a feed frame that stands for a run of positions (`feed.from`): the writer may coalesce a thread's text appends for this
    /// connection (Node's phone mailbox, `remote-streaming-mailbox.ts`). A client without it gets every frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feed_ranges: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<InitializeCapabilities>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CoreState {
    Serving,
    #[serde(rename_all = "camelCase")]
    Migrating {
        kind: String,
        #[cfg_attr(feature = "codegen", ts(type = "number"))]
        done: u64,
        #[cfg_attr(feature = "codegen", ts(type = "number"))]
        total: u64,
    },
    #[serde(rename_all = "camelCase")]
    Draining {
        reason: mixdog_protocol::DrainReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CapabilityState {
    Available,
    Unavailable { detail: String },
}

/// Core capabilities (D6: office and JS skills are unavailable without Node).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    pub office: CapabilityState,
    pub js_skills: CapabilityState,
    pub browser: CapabilityState,
    pub computer: CapabilityState,
    pub voice: CapabilityState,
    /// What a paired phone may use: Node's relay challenge flags (`remote-relay-client-lifecycle.ts:117-151` at b6f10295a).
    /// Absent from a core that predates it; read that as every flag off.
    #[serde(default)]
    pub remote: RemoteCapabilities,
    /// The version of the window method table the server holds a window-scoped connection to (`boundary::window_scope`); 0 from a core that has none.
    #[serde(default)]
    pub window_scope: u32,
}

/// The features Node's relay announced to a phone in its challenge, each true when this core serves it. Node offered every flag
/// but `nativePush` always; `nativePush` only while the relay could deliver a native push (`relayNativePlatforms().length > 0`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteCapabilities {
    /// The update, trash, browser-page release, deduplicated submit, preview and pull-request calls (`remoteParity`).
    pub remote_parity: bool,
    /// `remoteAccess/registerNativePush`: the relay this core's leg is on delivers native pushes.
    pub native_push: bool,
    /// The remote browser pane may send the `viewport` control.
    pub browser_drive: bool,
    /// A conversation browser's tabs ride its frames and its tab controls are accepted.
    pub browser_session_tabs: bool,
    /// Terminal resizes follow the size-owner claim.
    pub term_size_owner: bool,
    /// The host folder browser (`projectFs/browseDirs`).
    pub host_directories: bool,
    /// The usage ledger's request list.
    pub usage_requests: bool,
    /// Project file recovery (`projectFs/recovery`).
    pub project_recovery: bool,
    /// `autoEffort` in model selections.
    pub route_auto_effort: bool,
    /// The agent visualize panel.
    pub visualize: bool,
    /// The host file download lane (`transfer/*`).
    pub file_downloads: bool,
    /// A handoff secret typed on the phone (`approval/provideSecret`).
    pub secret_input: bool,
    /// The WebRTC live view's version (Node's `REMOTE_WEBRTC_VERSION`); 0 when it is not served.
    pub browser_webrtc: u32,
    /// A take-over's fit is honored and frames are marked.
    pub browser_fit: bool,
    /// The encrypted HTTP media lane.
    pub media_e2ee: bool,
}

/// What the core knows about this connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub origin: Origin,
    /// Host-stamped device name used on submits, aborts and decisions (today's `viewerDevice`).
    pub device: String,
    /// The id of the desktop window this connection is the socket of (`Mixdog-Window`); absent for any other connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub window: Option<String>,
}

/// How this core start's one-time `desktop` defaults separation ended (Node's app-ready `separateDefaults`). A
/// failure never stops the core; the desktop records it in its own diagnostics log as `defaults-separation-failed`
/// with `{ message }`, and the next start tries again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct DefaultsSeparation {
    pub ok: bool,
    /// The failure's `error.message`, as Node's catch received it; absent when `ok`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Default for DefaultsSeparation {
    fn default() -> Self {
        Self { ok: true, message: None }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
    /// Set once per core start, before any connection is served.
    /// Absent from a core that predates it; read that as `ok`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub defaults_separation: Option<DefaultsSeparation>,
    pub user_agent: String,
    pub platform_family: String,
    pub platform_os: String,
    pub server_version: String,
    pub server_build: String,
    /// Changes on every core start; a different value means every held epoch is stale.
    pub server_instance_id: String,
    pub core_state: CoreState,
    pub limits: Limits,
    pub capabilities: ServerCapabilities,
    pub connection: ConnectionInfo,
}

/// `initialized` carries no params.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct InitializedParams {}
