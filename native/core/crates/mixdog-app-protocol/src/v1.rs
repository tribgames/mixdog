//! `initialize` / `initialized` (P §4.4, X4, X16).

use mixdog_protocol::ConnectionKind;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::common::Origin;
use crate::limits::Limits;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
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
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema, TS)]
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
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<InitializeCapabilities>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CoreState {
    Serving,
    #[serde(rename_all = "camelCase")]
    Migrating {
        kind: String,
        #[ts(type = "number")]
        done: u64,
        #[ts(type = "number")]
        total: u64,
    },
    #[serde(rename_all = "camelCase")]
    Draining {
        reason: mixdog_protocol::DrainReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CapabilityState {
    Available,
    Unavailable { detail: String },
}

/// Core capabilities (D6: office and JS skills are unavailable without Node).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    pub office: CapabilityState,
    pub js_skills: CapabilityState,
    pub browser: CapabilityState,
    pub computer: CapabilityState,
    pub voice: CapabilityState,
}

/// What the core knows about this connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub origin: Origin,
    /// Host-stamped device name used on submits, aborts and decisions (today's `viewerDevice`).
    pub device: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
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
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema, TS)]
pub struct InitializedParams {}
