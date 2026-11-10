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
pub struct ConfigValueWriteParams {
    pub op_id: OpId,
    #[serde(flatten)]
    pub edit: ConfigEdit,
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
