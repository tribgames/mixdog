//! `op/status` (P §9.4), `blob/read` and `blob/put` (P §3, SPEC R1).
//! Blob methods are not mutations: blobs are content-addressed, so a repeated
//! chunk or read has one effect without an op id.

use mixdog_protocol::BlobDigest;
use mixdog_protocol::JsonValue;
use mixdog_protocol::OpId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// `thread:<id>` or a domain name (`config`, `project`, …).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(transparent)]
pub struct OpScopeName(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct OpStatusParams {
    pub scope: OpScopeName,
    pub op_ids: Vec<OpId>,
    /// Record every unknown id newer than the watermark as fenced before answering.
    pub fence: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum OpState {
    #[serde(rename_all = "camelCase")]
    Applied {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        seq: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        result: Option<JsonValue>,
    },
    /// `error` is the JSON-RPC error body the op answered with.
    Rejected {
        error: JsonValue,
    },
    InProgress,
    #[serde(rename_all = "camelCase")]
    ExternalUnknown {
        effect: String,
        target: String,
    },
    /// Final: the id is fenced and can never execute.
    NotApplied,
    /// Older than the retention watermark: the outcome cannot be known.
    Expired,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct OpStatusEntry {
    pub op_id: OpId,
    #[serde(flatten)]
    pub state: OpState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct OpStatusResponse {
    pub ops: Vec<OpStatusEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct BlobReadParams {
    pub digest: BlobDigest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub offset: Option<u64>,
    /// At most `limits.maxBlobPageBytes`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub length: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct BlobReadResponse {
    pub bytes_b64: String,
}

/// One upload chunk; raw chunk ≤ `limits.maxBlobPutChunkBytes`. The blob is
/// complete when the bytes received hash to `digest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct BlobPutParams {
    pub digest: BlobDigest,
    #[ts(type = "number")]
    pub offset: u64,
    pub bytes_b64: String,
}
