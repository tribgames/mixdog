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
    use std::sync::Arc;

    use mixdog_store::sqlite::DirtyMark;
    use mixdog_store::sqlite::SqliteStore;
    use mixdog_store::summary::CatalogHead;
    use serde_json::Value;

    use super::*;

    /// The index of a data dir holding each of `headers` as a listed session.
    async fn index(data: &std::path::Path, headers: &[Value]) -> Arc<SqliteStore> {
        let tokens = mixdog_rt::testing::tokens();
        let root = data.to_path_buf();
        let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
        let store = Arc::new(index);
        for header in headers {
            let header = header.as_object().expect("header").clone();
            let session = header["id"].as_str().expect("id").to_owned();
            store.upsert(CatalogHead { session, log_id: "L".into(), base_session: None, header }, DirtyMark::Clear).await.expect("upsert");
        }
        store
    }

    /// `ThreadStore::session_meta` of the real store, over the same index calls.
    async fn meta_of(store: &SqliteStore, id: &str) -> Option<SessionMeta> {
        let summary = store.summary(id).await.expect("summary")?;
        let title = store.title(id).await.expect("title");
        Some(SessionMeta::of(title, &summary))
    }

    /// Every case of `fixtures/session-metadata/golden.json`: what Node's `readStoredSessionMetadata`
    /// gave for the log record of that header, whether `isLeadVisibleRow` takes it as the usage
    /// service asks, and the records Node reads as `null`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn metadata_equals_nodes() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/session-metadata/golden.json")).expect("golden json");
        let cases = golden["cases"].as_array().expect("cases");
        let nulls = golden["nulls"].as_array().expect("nulls");
        let mut headers: Vec<Value> = cases.iter().map(|case| case["header"].clone()).collect();
        // The index holds a deleted session as a row with the delete mark; the others have no row.
        headers.push(json!({ "id": "s_unlinked", "title": "deleted", "deleted": true }));
        let data = tempfile::tempdir().expect("data dir");
        let store = index(data.path(), &headers).await;
        for case in cases {
            let id = case["id"].as_str().expect("id");
            let mut got = describe(id, meta_of(&store, id).await).unwrap_or_else(|| panic!("{id} is listed"));
            let mut want = case["expected"].clone();
            // Node's `session.owner || null`; the list row holds `|| 'user'`, which `isLeadVisibleRow` applies too.
            if want["owner"].is_null() {
                want["owner"] = json!("user");
            }
            assert_eq!(got, want, "{id}");
            got["preview"] = json!("x");
            let visible = mixdog_store::sqlite::lead::is_lead_visible_row(got.as_object().expect("row"));
            assert_eq!(visible, case["leadVisible"], "{id} lead visible");
        }
        for null in nulls {
            let id = null["id"].as_str().expect("id");
            assert_eq!(describe(id, meta_of(&store, id).await), None, "{id}: {}", null["how"]);
        }
    }
}
