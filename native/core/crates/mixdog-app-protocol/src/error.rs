//! Error codes and the complete set of `data.reason` values (P §10, SPEC §4.4,
//! R7). The same reason objects appear in `turn/completed.turn.error.data`,
//! `error` notifications and `serverRequest/resolved`.

use mixdog_protocol::BlobDigest;
use mixdog_protocol::ItemId;
use mixdog_protocol::JsonValue;
use mixdog_protocol::OpId;
use mixdog_protocol::QueuedId;
use mixdog_protocol::ThreadId;
use mixdog_protocol::TurnId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::common::Origin;
use crate::common::RequestClass;
use crate::rpc::JsonRpcErrorBody;
use crate::rpc::RequestId;

pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;
pub const OVERLOADED: i64 = -32001;

pub use mixdog_protocol::DomainErrorDetail;
pub use mixdog_protocol::DrainReason;

/// `{"reason": …, …typed fields}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "reason", rename_all = "camelCase")]
pub enum ErrorData {
    // -32600
    NotInitialized,
    AlreadyInitialized,
    #[serde(rename_all = "camelCase")]
    ClientOutdated {
        server_version: String,
        client_version: String,
    },
    #[serde(rename_all = "camelCase")]
    ServerOutdated {
        server_version: String,
        client_version: String,
    },
    #[serde(rename_all = "camelCase")]
    ServerShuttingDown {
        drain_reason: DrainReason,
    },
    #[serde(rename_all = "camelCase")]
    CoreMigrating {
        kind: String,
        #[ts(type = "number")]
        done: u64,
        #[ts(type = "number")]
        total: u64,
    },
    #[serde(rename_all = "camelCase")]
    CatalogRebuilding {
        #[ts(type = "number")]
        done: u64,
        #[ts(type = "number")]
        total: u64,
    },
    #[serde(rename_all = "camelCase")]
    ThreadNotFound {
        thread_id: ThreadId,
    },
    #[serde(rename_all = "camelCase")]
    ThreadClosing {
        thread_id: ThreadId,
    },
    #[serde(rename_all = "camelCase")]
    TurnNotActive {
        thread_id: ThreadId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        turn_id: Option<TurnId>,
    },
    #[serde(rename_all = "camelCase")]
    ItemNotFound {
        thread_id: ThreadId,
        item_id: ItemId,
    },
    #[serde(rename_all = "camelCase")]
    QueuedEntryNotFound {
        thread_id: ThreadId,
        queued_id: QueuedId,
    },
    #[serde(rename_all = "camelCase")]
    PreconditionFailed {
        expected: JsonValue,
        actual: JsonValue,
    },
    #[serde(rename_all = "camelCase")]
    PermissionDenied {
        method: String,
        origin: Origin,
    },
    #[serde(rename_all = "camelCase")]
    CapabilityUnavailable {
        capability: String,
        detail: String,
    },
    #[serde(rename_all = "camelCase")]
    OpFenced {
        op_id: OpId,
    },
    /// Internal only: a request racing its own connection's close.
    ConnectionClosed,
    #[serde(rename_all = "camelCase")]
    StoreDamaged {
        thread_id: ThreadId,
        #[ts(type = "number")]
        file_no: u64,
        #[ts(type = "number")]
        offset: u64,
    },
    /// The blob is permanently unavailable (never stored, or collected):
    /// the client fails that one read; it is not a protocol violation.
    #[serde(rename_all = "camelCase")]
    BlobNotFound {
        digest: BlobDigest,
    },
    #[serde(rename_all = "camelCase")]
    ItemTooLarge {
        #[ts(type = "number")]
        limit: u64,
    },
    /// A failure of a domain operation (today's coded errors such as `WORKTREE_DIRTY`), as
    /// Node's error carries it: `code` is the domain's stable code, absent when the failure
    /// has none (a plain `Error`); `message` is `error.message`; `detail` the typed fields.
    #[serde(rename_all = "camelCase")]
    DomainError {
        domain: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        detail: Option<Box<DomainErrorDetail>>,
    },
    // -32601
    #[serde(rename_all = "camelCase")]
    MethodNotFound {
        method: String,
    },
    // -32602
    #[serde(rename_all = "camelCase")]
    InvalidParams {
        path: String,
        expected: String,
    },
    #[serde(rename_all = "camelCase")]
    OpIdConflict {
        op_id: OpId,
    },
    #[serde(rename_all = "camelCase")]
    OpIdExpired {
        op_id: OpId,
        watermark: String,
    },
    OpIdRequired,
    #[serde(rename_all = "camelCase")]
    CursorInvalidated {
        thread_id: ThreadId,
        #[ts(type = "number")]
        history_rev: u64,
    },
    #[serde(rename_all = "camelCase")]
    InputTooLarge {
        #[ts(type = "number")]
        limit: u64,
    },
    // -32603
    #[serde(rename_all = "camelCase")]
    Internal {
        incident_id: String,
    },
    #[serde(rename_all = "camelCase")]
    BarrierFailed {
        scope: String,
        io_kind: String,
    },
    #[serde(rename_all = "camelCase")]
    StorageIndeterminate {
        scope: String,
    },
    /// Boot probe failure; never a request error.
    #[serde(rename_all = "camelCase")]
    StorageUnsupported {
        op: String,
        os_error: String,
    },
    #[serde(rename_all = "camelCase")]
    ExternalOutcomeUnknown {
        op_id: OpId,
        effect: String,
        target: String,
    },
    #[serde(rename_all = "camelCase")]
    ProviderError {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        status: Option<u16>,
        kind: String,
    },
    #[serde(rename_all = "camelCase")]
    Cancelled {
        by: String,
    },
    #[serde(rename_all = "camelCase")]
    BlobCorrupt {
        digest: BlobDigest,
    },
    // -32001
    #[serde(rename_all = "camelCase")]
    InflightLimit {
        class: RequestClass,
        #[ts(type = "number")]
        limit: u32,
    },
    /// Durability window full; retry after the thread's next feed event.
    #[serde(rename_all = "camelCase")]
    WindowFull {
        thread_id: ThreadId,
    },
    /// A bounded queue is full; retry after an own response.
    #[serde(rename_all = "camelCase")]
    QueueFull {
        queue: String,
    },
    // `error` notification to the sending connection only (P §8.4 step 5).
    #[serde(rename_all = "camelCase")]
    InvalidServerRequestResponse {
        request_id: RequestId,
        detail: String,
    },
}

impl ErrorData {
    /// The JSON-RPC code of this reason.
    pub fn code(&self) -> i64 {
        match self {
            Self::NotInitialized
            | Self::AlreadyInitialized
            | Self::ClientOutdated { .. }
            | Self::ServerOutdated { .. }
            | Self::ServerShuttingDown { .. }
            | Self::CoreMigrating { .. }
            | Self::CatalogRebuilding { .. }
            | Self::ThreadNotFound { .. }
            | Self::ThreadClosing { .. }
            | Self::TurnNotActive { .. }
            | Self::ItemNotFound { .. }
            | Self::QueuedEntryNotFound { .. }
            | Self::PreconditionFailed { .. }
            | Self::PermissionDenied { .. }
            | Self::CapabilityUnavailable { .. }
            | Self::OpFenced { .. }
            | Self::ConnectionClosed
            | Self::StoreDamaged { .. }
            | Self::BlobNotFound { .. }
            | Self::ItemTooLarge { .. }
            | Self::DomainError { .. }
            | Self::InvalidServerRequestResponse { .. } => INVALID_REQUEST,
            Self::MethodNotFound { .. } => METHOD_NOT_FOUND,
            Self::InvalidParams { .. }
            | Self::OpIdConflict { .. }
            | Self::OpIdExpired { .. }
            | Self::OpIdRequired
            | Self::CursorInvalidated { .. }
            | Self::InputTooLarge { .. } => INVALID_PARAMS,
            Self::Internal { .. }
            | Self::BarrierFailed { .. }
            | Self::StorageIndeterminate { .. }
            | Self::StorageUnsupported { .. }
            | Self::ExternalOutcomeUnknown { .. }
            | Self::ProviderError { .. }
            | Self::Cancelled { .. }
            | Self::BlobCorrupt { .. } => INTERNAL_ERROR,
            Self::InflightLimit { .. } | Self::WindowFull { .. } | Self::QueueFull { .. } => {
                OVERLOADED
            }
        }
    }

    /// The wire `reason` string.
    pub fn reason(&self) -> String {
        match serde_json::to_value(self) {
            Ok(JsonValue::Object(map)) => match map.get("reason") {
                Some(JsonValue::String(reason)) => reason.clone(),
                _ => unreachable!("ErrorData is tagged by reason"),
            },
            _ => unreachable!("ErrorData serializes to an object"),
        }
    }

    /// The JSON-RPC error body; `message` is English for logs only.
    pub fn into_body(self, message: impl Into<String>) -> JsonRpcErrorBody {
        JsonRpcErrorBody {
            code: self.code(),
            data: Some(serde_json::to_value(&self).expect("ErrorData serializes")),
            message: message.into(),
        }
    }

    /// Decodes `data` of a received error body.
    pub fn from_body(body: &JsonRpcErrorBody) -> Option<Self> {
        body.data
            .clone()
            .and_then(|data| serde_json::from_value(data).ok())
    }
}
