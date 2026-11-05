//! The one place `CoreError` becomes wire `ErrorData` (P §10, SPEC §4.4). Every error the
//! server sends, as a response to a request, an `error` notification or an `op/status`
//! rejection, goes through [`error_data`], so no processor invents a reason.

use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_app_protocol::ErrorData;
use mixdog_app_protocol::RequestId;
use mixdog_core_api::CoreError;
use mixdog_core_api::error::Precondition;
use serde_json::Value;
use serde_json::json;

/// The wire form of `error`.
pub fn error_data(error: &CoreError) -> ErrorData {
    match error {
        CoreError::ServerShuttingDown { drain_reason } => ErrorData::ServerShuttingDown {
            drain_reason: *drain_reason,
        },
        CoreError::CoreMigrating { kind, done, total } => ErrorData::CoreMigrating {
            kind: kind.to_string(),
            done: *done,
            total: *total,
        },
        CoreError::ThreadNotFound { thread_id } => ErrorData::ThreadNotFound {
            thread_id: thread_id.clone(),
        },
        CoreError::ThreadClosing { thread_id } => ErrorData::ThreadClosing {
            thread_id: thread_id.clone(),
        },
        CoreError::TurnNotActive { thread_id, turn_id } => ErrorData::TurnNotActive {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
        },
        CoreError::ItemNotFound { thread_id, item_id } => ErrorData::ItemNotFound {
            thread_id: thread_id.clone(),
            item_id: item_id.clone(),
        },
        CoreError::QueuedEntryNotFound {
            thread_id,
            queued_id,
        } => ErrorData::QueuedEntryNotFound {
            thread_id: thread_id.clone(),
            queued_id: queued_id.clone(),
        },
        CoreError::PreconditionFailed { precondition } => {
            let (expected, actual) = precondition_values(precondition);
            ErrorData::PreconditionFailed { expected, actual }
        }
        CoreError::PermissionDenied { method, origin } => ErrorData::PermissionDenied {
            method: method.to_string(),
            origin: *origin,
        },
        CoreError::CapabilityUnavailable { capability, detail } => {
            ErrorData::CapabilityUnavailable {
                capability: capability.to_string(),
                detail: detail.to_string(),
            }
        }
        CoreError::OpFenced { op_id } => ErrorData::OpFenced {
            op_id: op_id.clone(),
        },
        CoreError::ConnectionClosed => ErrorData::ConnectionClosed,
        CoreError::InvalidParams { path, expected } => ErrorData::InvalidParams {
            path: path.to_string(),
            expected: expected.to_string(),
        },
        CoreError::OpIdConflict { op_id } => ErrorData::OpIdConflict {
            op_id: op_id.clone(),
        },
        CoreError::OpIdExpired { op_id, watermark } => ErrorData::OpIdExpired {
            op_id: op_id.clone(),
            watermark: watermark.to_string(),
        },
        CoreError::OpIdRequired => ErrorData::OpIdRequired,
        CoreError::CursorInvalidated {
            thread_id,
            history_rev,
        } => ErrorData::CursorInvalidated {
            thread_id: thread_id.clone(),
            history_rev: *history_rev,
        },
        CoreError::InputTooLarge { limit } => ErrorData::InputTooLarge { limit: *limit },
        CoreError::Internal { incident_id } => ErrorData::Internal {
            incident_id: incident_id.to_string(),
        },
        CoreError::BarrierFailed { scope, io_kind } => ErrorData::BarrierFailed {
            scope: scope.to_string(),
            io_kind: io_kind.to_string(),
        },
        CoreError::StorageIndeterminate { scope } => ErrorData::StorageIndeterminate {
            scope: scope.to_string(),
        },
        CoreError::StorageUnsupported { op, os_error } => ErrorData::StorageUnsupported {
            op: op.to_string(),
            os_error: os_error.to_string(),
        },
        CoreError::ExternalOutcomeUnknown {
            op_id,
            effect,
            target,
        } => ErrorData::ExternalOutcomeUnknown {
            op_id: op_id.clone(),
            effect: effect.to_string(),
            target: target.to_string(),
        },
        CoreError::ProviderError {
            provider,
            status,
            kind,
        } => ErrorData::ProviderError {
            provider: provider.to_string(),
            status: *status,
            kind: kind.to_string(),
        },
        CoreError::Cancelled { by } => ErrorData::Cancelled { by: by.to_string() },
        CoreError::StoreDamaged {
            thread_id,
            file_no,
            offset,
        } => ErrorData::StoreDamaged {
            thread_id: thread_id.clone(),
            file_no: *file_no,
            offset: *offset,
        },
        CoreError::ItemTooLarge { limit } => ErrorData::ItemTooLarge { limit: *limit },
        CoreError::CatalogRebuilding { done, total } => ErrorData::CatalogRebuilding {
            done: *done,
            total: *total,
        },
        CoreError::BlobNotFound { digest } => ErrorData::BlobNotFound {
            digest: digest.clone(),
        },
        CoreError::BlobCorrupt { digest } => ErrorData::BlobCorrupt {
            digest: digest.clone(),
        },
        CoreError::DomainError {
            domain,
            code,
            detail,
        } => ErrorData::DomainError {
            domain: domain.to_string(),
            code: code.as_deref().map(str::to_owned),
            detail: detail.clone(),
        },
        // A server request's id is the durable approval id, always a string (P §8.2).
        CoreError::InvalidServerRequestResponse { request_id, detail } => {
            ErrorData::InvalidServerRequestResponse {
                request_id: RequestId::String(request_id.0.clone()),
                detail: detail.to_string(),
            }
        }
        CoreError::WindowFull { thread_id } => ErrorData::WindowFull {
            thread_id: thread_id.clone(),
        },
        CoreError::QueueFull { queue } => ErrorData::QueueFull {
            queue: queue.to_string(),
        },
        // `CoreError` is non-exhaustive: a reason this server does not know is a bug, shown
        // to the client as an incident whose detail is in the log.
        unmapped => ErrorData::Internal {
            incident_id: incident(&unmapped.to_string()),
        },
    }
}

/// The `expected` / `actual` members of `preconditionFailed` (P §10). Content is compared by
/// clients as the text they sent in `expectedContent`; an absent file is `null`.
pub fn precondition_values(precondition: &Precondition) -> (Value, Value) {
    match precondition {
        Precondition::Content { expected, actual } => {
            let text = |bytes: &Option<bytes::Bytes>| match bytes {
                Some(bytes) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
                None => Value::Null,
            };
            (text(expected), text(actual))
        }
        Precondition::LastUsedAt { expected, actual } => (
            json!({ "lastUsedAt": expected }),
            json!({ "lastUsedAt": actual }),
        ),
        Precondition::Revision { expected, actual } => (
            Value::String(expected.to_string()),
            Value::String(actual.to_string()),
        ),
    }
}

/// A bug of the server or a wiring gap: logged with a fresh incident id, answered as
/// `internal{incidentId}` (details only in the core log).
pub(crate) fn internal(what: &str) -> CoreError {
    CoreError::Internal {
        incident_id: incident(what).into(),
    }
}

fn incident(what: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let incident_id = format!(
        "srv-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    tracing::error!(incident_id, what, "app-server internal error");
    incident_id
}

/// The English `message` member: for logs only, never parsed by a client.
pub(crate) fn message(data: &ErrorData) -> String {
    data.reason()
}

/// The JSON-RPC error body of `error`, as embedded in a recorded op outcome.
pub(crate) fn error_body(error: &CoreError) -> Value {
    let data = error_data(error);
    let message = message(&data);
    serde_json::to_value(data.into_body(message)).expect("error body serializes")
}
