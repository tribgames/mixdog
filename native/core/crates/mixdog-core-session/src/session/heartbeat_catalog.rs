//! The production [`SessionCatalog`] of Mixy's heartbeat: Node's `listSessionCatalog`
//! (`session-action.mjs`), which lists the stored summaries newest activity first, agent-only
//! records left out (`includeAgentOnly: false`), with the runtime's `working` / `agentWorking` and
//! `awaitingApproval` laid over (`withRuntimeActivity`, `withApprovalWaits`: [`ListOverlay`]).
//! The rows come from the store's one session listing (`SqliteStore::list_sessions`), the same
//! the idle sweep reads.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_services::bots::beat::CatalogPage;
use mixdog_services::bots::beat::CatalogRow;
use mixdog_services::bots::beat::SessionCatalog;
use mixdog_store::sqlite::SqliteStore;
use mixdog_store::sqlite::lead::decode_catalog_cursor;
use mixdog_store::sqlite::lead::encode_catalog_cursor;
use mixdog_store::summary::is_root_lead_session;
use serde_json::Map;
use serde_json::Value;

use super::thread_list::ListOverlay;

pub struct StoredSessionCatalog {
    store: Arc<SqliteStore>,
    overlay: Arc<dyn ListOverlay>,
}

impl StoredSessionCatalog {
    pub fn new(store: Arc<SqliteStore>, overlay: Arc<dyn ListOverlay>) -> Self {
        Self { store, overlay }
    }
}

fn text(row: &Map<String, Value>, key: &str) -> String {
    row.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn millis(row: &Map<String, Value>, key: &str) -> i64 {
    row.get(key).and_then(Value::as_f64).filter(|n| *n > 0.0).map_or(0, |n| n as i64)
}

fn catalog_row(row: &Map<String, Value>, overlay: &dyn ListOverlay) -> CatalogRow {
    let id = text(row, "id");
    let live = overlay.of(&ThreadId::from(id.as_str()));
    CatalogRow {
        title: text(row, "title"),
        last_message_preview: text(row, "lastMessagePreview"),
        preview: text(row, "preview"),
        last_used_at: millis(row, "lastUsedAt"),
        updated_at: millis(row, "updatedAt"),
        working: live.working.unwrap_or(false),
        agent_working: live.agent_working.unwrap_or(false),
        source_name: text(row, "sourceName"),
        source_type: text(row, "sourceType"),
        owner: text(row, "owner"),
        visibility: text(row, "visibility"),
        root_lead: is_root_lead_session(row),
        id,
    }
}

#[async_trait]
impl SessionCatalog for StoredSessionCatalog {
    /// `limit` rows after `cursor`; the next cursor names the last row only when more follow.
    async fn page(&self, limit: usize, cursor: Option<&str>) -> Result<CatalogPage, String> {
        let after = decode_catalog_cursor(cursor).map_err(|error| error.to_string())?;
        let mut listed = self.store.list_sessions(false, after, Some(limit + 1)).await.map_err(|error| error.to_string())?;
        let more = listed.len() > limit;
        listed.truncate(limit);
        let next_cursor = if more { listed.last().map(|last| encode_catalog_cursor(&last.row)) } else { None };
        Ok(CatalogPage { sessions: listed.iter().map(|l| catalog_row(&l.row, self.overlay.as_ref())).collect(), next_cursor })
    }

    fn awaiting_approval(&self, session_id: &str) -> bool {
        self.overlay.of(&ThreadId::from(session_id)).awaiting_approval == Some(true)
    }
}

#[cfg(test)]
mod tests {
    use mixdog_rt::CancellationToken;
    use mixdog_rt::LaneToken;
    use mixdog_rt::testing::tokens;
    use mixdog_store::sqlite::DirtyMark;
    use mixdog_store::summary::CatalogHead;
    use serde_json::json;

    use super::super::thread_list::RowOverlay;
    use super::*;

    struct Live;

    impl ListOverlay for Live {
        fn of(&self, thread: &ThreadId) -> RowOverlay {
            RowOverlay { working: Some(thread.as_str() == "s_a"), awaiting_approval: Some(thread.as_str() == "s_b"), ..RowOverlay::default() }
        }
    }

    /// Every session but the agent-only ones, newest activity first, in pages, with the fields the
    /// heartbeat reads and the runtime's overlay.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_catalog_lists_every_non_agent_only_session_in_pages() {
        let tmp = tempfile::tempdir().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let data = tmp.path().to_path_buf();
        let _job = tokens()
            .maintenance_io
            .submit(&CancellationToken::new(), move |lane| {
                let _ = tx.send(SqliteStore::open(lane, tokens().sqlite_writer_thread, tokens().interactive_io, &data));
            })
            .unwrap();
        let store = Arc::new(rx.recv().unwrap().unwrap());
        for (id, header) in [
            ("s_a", json!({"updatedAt": 300, "owner": "cli", "sourceName": "lead"})),
            ("s_b", json!({"updatedAt": 200, "lastUsedAt": 250, "owner": "agent", "sourceName": "agent:mixy@run", "sourceType": "exec"})),
            ("s_c", json!({"updatedAt": 150, "owner": "agent", "visibility": "agent-only"})),
            ("s_d", json!({"updatedAt": 100})),
        ] {
            let mut header = header.as_object().unwrap().clone();
            header.insert("id".into(), json!(id));
            store.upsert(CatalogHead { session: id.into(), log_id: "L".into(), base_session: None, header }, DirtyMark::Clear).await.unwrap();
        }
        let catalog = StoredSessionCatalog::new(store, Arc::new(Live));
        let first = catalog.page(2, None).await.unwrap();
        assert_eq!(first.sessions.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["s_a", "s_b"]);
        let (a, b) = (&first.sessions[0], &first.sessions[1]);
        assert_eq!((a.working, a.owner.as_str(), a.source_name.as_str(), a.updated_at), (true, "cli", "lead", 300));
        assert_eq!((b.last_used_at, b.source_name.as_str(), b.source_type.as_str(), b.visibility.as_str()), (250, "agent:mixy@run", "exec", "ordinary"));
        let rest = catalog.page(2, first.next_cursor.as_deref()).await.unwrap();
        assert_eq!(rest.sessions.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["s_d"], "agent-only s_c is not listed");
        assert_eq!(rest.next_cursor, None);
        assert!(catalog.awaiting_approval("s_b") && !catalog.awaiting_approval("s_a"));
    }
}