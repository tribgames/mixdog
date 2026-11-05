//! `CoreError`: the semantic error of every core operation across the seams (P §10,
//! SPEC §4.4). It has no wire shape: `mixdog-app-server` converts it to the protocol's
//! error data in exactly one place.

use std::fmt;
use std::sync::Arc;

use bytes::Bytes;
use mixdog_protocol::BlobDigest;
use mixdog_protocol::DomainErrorDetail;
use mixdog_protocol::Origin;

use crate::handle::DrainReason;
use crate::ids::ItemId;
use crate::ids::OpId;
use crate::ids::QueuedId;
use crate::ids::ServerRequestId;
use crate::ids::ThreadId;
use crate::ids::TurnId;

pub mod stored;

#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum CoreError {
    ServerShuttingDown {
        drain_reason: DrainReason,
    },
    CoreMigrating {
        kind: Arc<str>,
        done: u64,
        total: u64,
    },
    ThreadNotFound {
        thread_id: ThreadId,
    },
    ThreadClosing {
        thread_id: ThreadId,
    },
    TurnNotActive {
        thread_id: ThreadId,
        turn_id: Option<TurnId>,
    },
    ItemNotFound {
        thread_id: ThreadId,
        item_id: ItemId,
    },
    QueuedEntryNotFound {
        thread_id: ThreadId,
        queued_id: QueuedId,
    },
    PreconditionFailed {
        precondition: Precondition,
    },
    PermissionDenied {
        method: Arc<str>,
        origin: Origin,
    },
    CapabilityUnavailable {
        capability: Arc<str>,
        detail: Arc<str>,
    },
    OpFenced {
        op_id: OpId,
    },
    /// Answer to work racing the close of its connection or subscription; never reaches the
    /// wire.
    ConnectionClosed,
    InvalidParams {
        path: Arc<str>,
        expected: Arc<str>,
    },
    OpIdConflict {
        op_id: OpId,
    },
    OpIdExpired {
        op_id: OpId,
        watermark: Arc<str>,
    },
    OpIdRequired,
    CursorInvalidated {
        thread_id: ThreadId,
        history_rev: u64,
    },
    InputTooLarge {
        limit: u64,
    },
    Internal {
        incident_id: Arc<str>,
    },
    BarrierFailed {
        scope: Arc<str>,
        io_kind: Arc<str>,
    },
    StorageIndeterminate {
        scope: Arc<str>,
    },
    /// The boot storage probe failed; reported by the core's lifecycle, never by a request.
    StorageUnsupported {
        op: Arc<str>,
        os_error: Arc<str>,
    },
    ExternalOutcomeUnknown {
        op_id: OpId,
        effect: Arc<str>,
        target: Arc<str>,
    },
    ProviderError {
        provider: Arc<str>,
        status: Option<u16>,
        kind: Arc<str>,
    },
    Cancelled {
        by: Arc<str>,
    },
    StoreDamaged {
        thread_id: ThreadId,
        file_no: u64,
        offset: u64,
    },
    ItemTooLarge {
        limit: u64,
    },
    CatalogRebuilding {
        done: u64,
        total: u64,
    },
    /// The blob was never stored or was collected.
    BlobNotFound {
        digest: BlobDigest,
    },
    BlobCorrupt {
        digest: BlobDigest,
    },
    /// A coded failure of a domain operation; `code` is the domain's stable code (for example
    /// `WORKTREE_DIRTY`) and `detail` its optional structured hint, never message text.
    DomainError {
        domain: Arc<str>,
        code: Arc<str>,
        detail: Option<Box<DomainErrorDetail>>,
    },
    InvalidServerRequestResponse {
        request_id: ServerRequestId,
        detail: Arc<str>,
    },
    /// A thread's durability window is full (R7).
    WindowFull {
        thread_id: ThreadId,
    },
    /// A bounded core queue (actor control lane or inbox, steer queue, executor lane) is full.
    QueueFull {
        queue: Arc<str>,
    },
}

/// The compare-and-set check that failed (P §10 `preconditionFailed{expected, actual}`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Precondition {
    /// File content (`projectFs/writeText{expectedContent}`); `None` is an absent file.
    Content {
        expected: Option<Bytes>,
        actual: Option<Bytes>,
    },
    /// Idle delete (`thread/delete{ifIdle:{lastUsedAt}}`), milliseconds since the Unix epoch.
    LastUsedAt { expected: i64, actual: i64 },
    /// An opaque revision token (`indexRevision`, …).
    Revision {
        expected: Arc<str>,
        actual: Arc<str>,
    },
}

/// For logs only; never parsed and never sent as error text.
impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

impl std::error::Error for CoreError {}

impl From<mixdog_rt::LaneFull> for CoreError {
    fn from(full: mixdog_rt::LaneFull) -> Self {
        CoreError::QueueFull {
            queue: full.lane.name().into(),
        }
    }
}
