//! The usage service's session metadata (`usage-stats-api.mjs` `readSessionMetadata`:
//! `readStoredSessionTranscript(id, { metadataOnly: true })`, i.e. `readStoredSessionMetadata`).
//! It is [`SessionDirectory::session_meta`], the catalog index's answer, and nothing else reads a
//! session's files for it. Of Node's metadata object it answers the keys `describeRequestSessions`
//! reads, `title`, `agent`, `ownerSessionId` and `sourceType`, and those its `isLeadVisibleRow`
//! reads off the row (`id`, `owner`, `parentSessionId`, `visibility`, `sourceName`), each as
//! Node's `x || null` (the list row holds the same values; `owner` is its `|| 'user'` form, which
//! `isLeadVisibleRow` applies itself).
//!
//! `None` (Node: `null`) for every record Node reads as `null`, which the catalog lists as no row:
//! an absent, unreadable or foreign log, and a deleted session (Node's `deleteSession` unlinks the
//! log, `session-delete.mjs` `_unlinkIfThere(plan.logPath)`; the index's delete mark is the same
//! state before the purge removes the files). A failed read is `None` too: Node's
//! `stampedDerivationSteps` (`store-summary-catalog.mjs:146`) returns a `null` value for a record
//! that cannot be read, and `describeRequestSessions` catches a throw as `null`
//! (`usage-stats-api.mjs`, `Promise.resolve(sessionMetadata(id)).catch(() => null)`).
//!
//! A header `title` that is not a string cannot be answered: the index keeps `title` as text
//! (`CatalogRow.title`, `summary.rs` `str_field`), so it reads as `None` where Node returns the value.

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_domains::domains::ai_account::SessionMetadata;
use serde_json::Value;
use serde_json::json;

use super::directory::SessionDirectory;
use super::seams::SessionMeta;

/// The metadata object of the listed session `id`.
fn describe(id: &str, meta: Option<SessionMeta>) -> Option<Value> {
    meta.map(|meta| {
        let field = |key: &str| meta.row.get(key).cloned().unwrap_or(Value::Null);
        json!({
            "id": id,
            "sessionId": id,
            "owner": field("owner"),
            "agent": meta.agent,
            "parentSessionId": field("parentSessionId"),
            "ownerSessionId": meta.owner_session_id,
            "visibility": field("visibility"),
            "title": meta.title,
            "sourceType": meta.source_type,
            "sourceName": field("sourceName"),
        })
    })
}

#[async_trait]
impl SessionMetadata for SessionDirectory {
    async fn metadata(&self, session_id: &str) -> Option<Value> {
        describe(session_id, self.session_meta(&ThreadId::from(session_id)).await.ok().flatten())
    }
}

#[cfg(test)]
mod tests {





}


