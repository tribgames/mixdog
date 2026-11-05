//! `config/read`, `config/value/write`, `config/batchWrite` (DS §3). The
//! values themselves are pushed as section `config` (key = subtree).

use mixdog_protocol::ConfigPath;
use mixdog_protocol::ConfigWriteMode;
use mixdog_protocol::JsonValue;
use mixdog_protocol::OpId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<Vec<ConfigPath>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ConfigReadResponse {
    pub config: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ConfigEdit {
    pub path: ConfigPath,
    pub value: JsonValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ConfigWriteMode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigValueWriteParams {
    pub op_id: OpId,
    #[serde(flatten)]
    pub edit: ConfigEdit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigBatchWriteParams {
    pub op_id: OpId,
    pub edits: Vec<ConfigEdit>,
}

/// The stored value after the write (`initializeIfMissing` returns the kept value).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigWriteResponse {
    #[ts(type = "number")]
    pub revision: u64,
    pub values: Vec<JsonValue>,
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
