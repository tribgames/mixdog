//! The durable form of a `CoreError`: the stored response a duplicate op replays and
//! `op/status` reports (P §9.3, §9.4), for the `ops.outcome` of a domain scope and the
//! `detail` of a thread's `op` record alike. It is a storage encoding, never the wire
//! error (`mixdog-app-server` alone produces that). The mirror lives in the crate that
//! defines `CoreError`, so its match is exhaustive: a new variant does not compile until
//! the mirror names it.

use std::sync::Arc;

use mixdog_protocol::BlobDigest;
use mixdog_protocol::DomainErrorDetail;
use mixdog_protocol::DrainReason;
use mixdog_protocol::Origin;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use super::CoreError;
use super::Precondition;
use crate::ids::ItemId;
use crate::ids::OpId;
use crate::ids::QueuedId;
use crate::ids::ServerRequestId;
use crate::ids::ThreadId;
use crate::ids::TurnId;

/// The stored form of `error`.
pub fn rejection_to_json(error: &CoreError) -> Value {
    serde_json::to_value(StoredError::of(error)).expect("a stored error always serializes")
}

/// The error a stored rejection holds.
pub fn rejection_from_json(value: Value) -> Result<CoreError, CoreError> {
    serde_json::from_value::<StoredError>(value)
        .map(StoredError::into_error)
        .map_err(|_| CoreError::Internal {
            incident_id: "op-rejection-unreadable".into(),
        })
}

macro_rules! stored_error {
    ($($variant:ident $({ $($(#[$attr:meta])* $field:ident: $ty:ty),* $(,)? })?;)*) => {
        #[derive(Serialize, Deserialize)]
        // `kind` is a field of two variants, so the tag is `error`.
        #[serde(tag = "error", rename_all = "camelCase", rename_all_fields = "camelCase")]
        enum StoredError {
            $($variant $({ $($(#[$attr])* $field: $ty),* })?,)*
        }

        impl StoredError {
            fn of(error: &CoreError) -> Self {
                match error.clone() {
                    $(CoreError::$variant $({ $($field),* })? => StoredError::$variant $({ $($field),* })?,)*
                }
            }

            fn into_error(self) -> CoreError {
                match self {
                    $(StoredError::$variant $({ $($field),* })? => CoreError::$variant $({ $($field),* })?,)*
                }
            }
        }
    };
}

stored_error! {
    ServerShuttingDown { drain_reason: DrainReason };
    CoreMigrating { kind: Arc<str>, done: u64, total: u64 };
    ThreadNotFound { thread_id: ThreadId };
    ThreadClosing { thread_id: ThreadId };
    TurnNotActive { thread_id: ThreadId, turn_id: Option<TurnId> };
    ItemNotFound { thread_id: ThreadId, item_id: ItemId };
    QueuedEntryNotFound { thread_id: ThreadId, queued_id: QueuedId };
    PreconditionFailed { #[serde(with = "precondition")] precondition: Precondition };
    PermissionDenied { method: Arc<str>, origin: Origin };
    CapabilityUnavailable { capability: Arc<str>, detail: Arc<str> };
    OpFenced { op_id: OpId };
    ConnectionClosed;
    InvalidParams { path: Arc<str>, expected: Arc<str> };
    OpIdConflict { op_id: OpId };
    OpIdExpired { op_id: OpId, watermark: Arc<str> };
    OpIdRequired;
    CursorInvalidated { thread_id: ThreadId, history_rev: u64 };
    InputTooLarge { limit: u64 };
    Internal { incident_id: Arc<str> };
    BarrierFailed { scope: Arc<str>, io_kind: Arc<str> };
    StorageIndeterminate { scope: Arc<str> };
    StorageUnsupported { op: Arc<str>, os_error: Arc<str> };
    ExternalOutcomeUnknown { op_id: OpId, effect: Arc<str>, target: Arc<str> };
    ProviderError { provider: Arc<str>, status: Option<u16>, kind: Arc<str> };
    Cancelled { by: Arc<str> };
    StoreDamaged { thread_id: ThreadId, file_no: u64, offset: u64 };
    ItemTooLarge { limit: u64 };
    CatalogRebuilding { done: u64, total: u64 };
    BlobNotFound { digest: BlobDigest };
    BlobCorrupt { digest: BlobDigest };
    DomainError { domain: Arc<str>, code: Arc<str>, detail: Option<Box<DomainErrorDetail>> };
    InvalidServerRequestResponse { request_id: ServerRequestId, detail: Arc<str> };
    WindowFull { thread_id: ThreadId };
    QueueFull { queue: Arc<str> };
}

mod precondition {
    use std::sync::Arc;

    use bytes::Bytes;
    use serde::Deserialize;
    use serde::Deserializer;
    use serde::Serialize;
    use serde::Serializer;

    use crate::error::Precondition;

    #[derive(Serialize, Deserialize)]
    #[serde(
        tag = "kind",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )]
    enum Stored {
        Content {
            expected: Option<Vec<u8>>,
            actual: Option<Vec<u8>>,
        },
        LastUsedAt {
            expected: i64,
            actual: i64,
        },
        Revision {
            expected: Arc<str>,
            actual: Arc<str>,
        },
    }

    pub fn serialize<S: Serializer>(value: &Precondition, out: S) -> Result<S::Ok, S::Error> {
        let bytes = |b: &Option<Bytes>| b.as_ref().map(|b| b.to_vec());
        match value {
            Precondition::Content { expected, actual } => Stored::Content {
                expected: bytes(expected),
                actual: bytes(actual),
            },
            Precondition::LastUsedAt { expected, actual } => Stored::LastUsedAt {
                expected: *expected,
                actual: *actual,
            },
            Precondition::Revision { expected, actual } => Stored::Revision {
                expected: expected.clone(),
                actual: actual.clone(),
            },
        }
        .serialize(out)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(input: D) -> Result<Precondition, D::Error> {
        Ok(match Stored::deserialize(input)? {
            Stored::Content { expected, actual } => Precondition::Content {
                expected: expected.map(Bytes::from),
                actual: actual.map(Bytes::from),
            },
            Stored::LastUsedAt { expected, actual } => {
                Precondition::LastUsedAt { expected, actual }
            }
            Stored::Revision { expected, actual } => Precondition::Revision { expected, actual },
        })
    }
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;

    use super::*;

    #[test]
    fn a_stored_rejection_reads_back_as_the_same_error() {
        for error in [
            CoreError::PreconditionFailed {
                precondition: Precondition::Content {
                    expected: Some(Bytes::from_static(b"a\xff")),
                    actual: None,
                },
            },
            CoreError::ProviderError {
                provider: "anthropic".into(),
                status: Some(529),
                kind: "overloaded".into(),
            },
            CoreError::TurnNotActive {
                thread_id: ThreadId::from("t1"),
                turn_id: None,
            },
            CoreError::OpIdRequired,
        ] {
            let stored = rejection_to_json(&error);
            assert_eq!(rejection_from_json(stored).unwrap(), error);
        }
    }
}
