//! `config/read`, `config/value/write`, `config/batchWrite` (DS §3). The
//! values themselves are pushed as section `config` (key = subtree).

use mixdog_protocol::ConfigPath;
use mixdog_protocol::ConfigWriteMode;
use mixdog_protocol::JsonValue;
use mixdog_protocol::OpId;
use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ConfigReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<Vec<ConfigPath>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct ConfigReadResponse {
    pub config: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ConfigEdit {
    pub path: ConfigPath,
    pub value: JsonValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ConfigWriteMode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ConfigValueWriteParams {
    pub op_id: OpId,
    #[serde(flatten)]
    pub edit: ConfigEdit,
    /// The scope the writer announces once the write is saved (Node's `notifySettingsChanged(scope)` after
    /// `updateSetting`, remote-methods.ts:1098): `ui/settings/changed` is published even when the write changed nothing,
    /// before the `agent` change the write itself makes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub announce: Option<SettingsScope>,
}

/// Node's `SettingsChange.scope` (shared/settings-changed.ts `SETTINGS_SCOPES`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SettingsScope {
    Desktop,
    Git,
    Permissions,
    Notifications,
    Agent,
}

impl SettingsScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Git => "git",
            Self::Permissions => "permissions",
            Self::Notifications => "notifications",
            Self::Agent => "agent",
        }
    }
}

/// `ui/settings/changed` (app feed) and `ui/settings/announce`: Node's `settings-changed` desktop event, which reached
/// the windows and every paired device (ipc-state-bridge.ts:114, remote-relay-push-lanes.ts:54).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct UiSettingsChangedParams {
    pub scope: SettingsScope,
}

/// `ui/providerModels/changed` (app feed) and `ui/providerModels/announce`: Node's `provider-models-changed` desktop
/// event `{origin}` (ipc-state-bridge.ts:113, remote-relay-push-lanes.ts:53).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct UiProviderModelsChangedParams {
    pub origin: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigBatchWriteParams {
    pub op_id: OpId,
    pub edits: Vec<ConfigEdit>,
}

/// The stored value after the write (`initializeIfMissing` returns the kept value), and the `agent` and `desktop`
/// subtrees of the config that same locked update saved (what Node's `updateConfigAsync` returned to the desktop).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConfigWriteResponse {
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub revision: u64,
    pub values: Vec<JsonValue>,
    pub config: JsonValue,
}

impl crate::common::HasOpId for ConfigValueWriteParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}

impl crate::common::HasOpId for ConfigBatchWriteParams {
    fn op_id(&self) -> &OpId {
        &self.op_id
    }
}
