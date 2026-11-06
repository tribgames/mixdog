//! The durable side of one op scope (P §9.2): what an [`super::OpGate`] reads and writes.
//!
//! Each scope's owner is its only writer and supplies the store:
//! - `thread:<id>`: the thread's actor. Records live in the session log (the mutation record
//!   carries its op; `op` records carry rejections, fences and external states) and are
//!   looked up through the derived `thread_ops` table of `index/store.sqlite` plus the
//!   actor's records not yet indexed. They live as long as the log, so there is no watermark
//!   and no [`OpRetention`].
//! - every other scope: the `ops` and `op_watermarks` tables of `state/core.sqlite`, written
//!   by the domain's owner in the same transaction as the domain change (SPEC R30).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::OpId;
use serde_json::Value;

use super::digest::PayloadDigest;

/// One op's durable record.
#[derive(Clone, Debug, PartialEq)]
pub enum OpRecord {
    /// Recorded by `op/status{fence}` for an id it did not find: the id never executes.
    Fenced,
    Settled {
        method: Arc<str>,
        digest: PayloadDigest,
        state: OpState,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum OpState {
    Applied {
        seq: Option<u64>,
        /// The response result when it is ≤ 16 KiB; otherwise the owner reproduces it.
        result: Option<Value>,
    },
    Rejected {
        error: CoreError,
    },
    /// Durable before an external action starts (P §9.6). Found with no live execution, it
    /// reads as [`OpState::ExternalUnknown`]: the executor ended (process crash included)
    /// without recording the outcome.
    ExternalPending {
        effect: Arc<str>,
        target: Arc<str>,
    },
    ExternalUnknown {
        effect: Arc<str>,
        target: Arc<str>,
    },
}

#[async_trait]
pub trait OpStore: Send + Sync {
    /// The record of `id`. Includes every record whose [`super::OpTicket`] has completed:
    /// an owner makes its write visible here before it completes the ticket.
    async fn get(&self, id: &OpId) -> Result<Option<OpRecord>, CoreError>;

    /// Durably writes `record` for `id`, replacing any record of it.
    async fn put(&self, id: &OpId, record: OpRecord) -> Result<(), CoreError>;

    /// The persisted retention watermark (UUIDv7 milliseconds), if the scope ever pruned.
    async fn watermark(&self) -> Result<Option<u64>, CoreError>;
}

/// Bounded pruning of a non-thread scope (P §9.5), run on the owner's maintenance path.
#[async_trait]
pub trait OpRetention: Send + Sync {
    /// The UUIDv7 millisecond time of the `n`-th newest record (1-based); `None` when the
    /// scope holds fewer than `n` records.
    async fn nth_newest_ms(&self, n: usize) -> Result<Option<u64>, CoreError>;

    /// Persists the watermark.
    async fn set_watermark(&self, ms: u64) -> Result<(), CoreError>;

    /// Deletes up to `limit` of the oldest records whose op time is below `ms`; returns how
    /// many it deleted.
    async fn delete_before(&self, ms: u64, limit: usize) -> Result<usize, CoreError>;
}
