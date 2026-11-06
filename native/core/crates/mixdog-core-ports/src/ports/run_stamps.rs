//! The unattended-run registry's view of the session directory: the stored `run` stamp.

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;

/// The `run` stamped on a stored session (`runStampOf`, `human-gate/delegation.mjs:108`): the
/// session's `run` object, after Node's backfill of records older than the stamp. The session
/// directory owns it (WP-SESSION); it is answered without waiting from the headers it holds.
#[async_trait]
pub trait RunStamps: Send + Sync {
    async fn stamp_of(&self, thread: &ThreadId) -> Option<Value>;
}
