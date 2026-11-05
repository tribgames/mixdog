//! The durable op index read by `op/status` (P §9.4).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::call::CallContext;
use crate::error::CoreError;
use crate::ids::OpId;
use crate::ids::ThreadId;

/// The scope whose single owner writes an op's record (P §9.2).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum OpScope {
    /// `thread:<id>`, owned by that thread's actor.
    Thread(ThreadId),
    /// `config`, `account`, `agent`, `project`, … owned by that domain's actor.
    Domain(Arc<str>),
}

/// The semantic status of one op; the server converts it to the wire shape.
#[derive(Clone, Debug, PartialEq)]
pub enum OpStatus {
    Applied {
        seq: Option<u64>,
        result: Option<Value>,
    },
    Rejected {
        error: CoreError,
    },
    InProgress,
    ExternalUnknown {
        effect: Arc<str>,
        target: Arc<str>,
    },
    /// Final: with `fence`, an id not found is recorded fenced before this answer.
    NotApplied,
    /// Older than the scope's retention watermark; the outcome cannot be known.
    Expired,
}

#[async_trait]
pub trait OpIndex: Send + Sync {
    /// One status per id, in order. With `fence`, every id not found and newer than the
    /// watermark is recorded fenced before the answer, so a later arrival is refused
    /// `opFenced`.
    async fn status(
        &self,
        scope: &OpScope,
        ids: &[OpId],
        fence: bool,
        ctx: &CallContext,
    ) -> Result<Vec<OpStatus>, CoreError>;
}
