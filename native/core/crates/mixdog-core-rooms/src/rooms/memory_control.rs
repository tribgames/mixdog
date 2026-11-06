//! `MemoryControl` over the memory runtime's `memory` tool, called as the host acting for the
//! user (no `memory_caller`): it may list and delete any agent's pool and has no way to write
//! one, because this type only ever sends `list` and `delete`.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use async_trait::async_trait;
use mixdog_rt::DurabilityIo;
use mixdog_services::memory::core::action::{CoreContext, run};
use mixdog_services::memory::pg::db::Db;
use serde_json::{Value, json};

use super::RoomError;
use super::memory::{DeleteOutcome, MemoryControl, MemoryEntry, MemoryPage};

const DELETED: &str = "core deleted ";
/// The sentence the memory runtime answers a delete whose list version moved on with.
const STALE: &str = "memory indices changed";

pub struct RuntimeMemoryControl {
    db: Arc<Db>,
    data_dir: PathBuf,
    snapshot_revision: Arc<AtomicU64>,
    /// The lane the memory runtime reads project markers and writes its snapshot on.
    lane: DurabilityIo,
}

impl RuntimeMemoryControl {
    pub fn new(db: Arc<Db>, data_dir: PathBuf, snapshot_revision: Arc<AtomicU64>, lane: DurabilityIo) -> Self {
        Self { db, data_dir, snapshot_revision, lane }
    }

    async fn call(&self, args: Value) -> String {
        let ctx = CoreContext {
            db: &self.db,
            data_dir: &self.data_dir,
            session_cwd: None,
            snapshot_revision: &self.snapshot_revision,
            lane: self.lane,
        };
        run(&ctx, &args).await.text
    }
}

#[async_trait]
impl MemoryControl for RuntimeMemoryControl {
    async fn list(&self, agent_id: &str, offset: u32, limit: u32) -> Result<MemoryPage, RoomError> {
        let text = self
            .call(json!({ "op": "list", "agent_id": agent_id, "format": "json", "limit": limit, "offset": offset }))
            .await;
        page_of(text)
    }

    async fn delete(&self, agent_id: &str, id: u64, index_revision: &str) -> Result<DeleteOutcome, RoomError> {
        let text = self
            .call(json!({ "op": "delete", "agent_id": agent_id, "id": id, "index_revision": index_revision }))
            .await;
        outcome_of(text)
    }
}

/// A `list` reply (`JSON.stringify(page)`) as a page. An archived entry carries no `id` or
/// `index_revision` (null): it maps to id 0 and an empty revision, which no delete accepts.
fn page_of(text: String) -> Result<MemoryPage, RoomError> {
    let page: Value = serde_json::from_str(&text)
        .map_err(|_| RoomError::Port(if text.is_empty() { "The agent memory could not be read.".into() } else { text }))?;
    let entries = page
        .get("entries")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| MemoryEntry {
                    id: row.get("id").and_then(Value::as_u64).unwrap_or(0),
                    index_revision: row.get("index_revision").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    summary: row.get("summary").and_then(Value::as_str).unwrap_or_default().to_owned(),
                })
                .collect()
        })
        .unwrap_or_default();
    let next_offset = page.get("nextOffset").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
    Ok(MemoryPage { entries, next_offset })
}

fn outcome_of(text: String) -> Result<DeleteOutcome, RoomError> {
    if text.starts_with(DELETED) {
        Ok(DeleteOutcome::Deleted)
    } else if text.contains(STALE) {
        Ok(DeleteOutcome::StaleRevision)
    } else {
        Err(RoomError::Port(if text.is_empty() { "The agent memory entry could not be deleted.".into() } else { text }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Replies recorded from Node's own memory code (`indexedCoreRecord`, `JSON.stringify`, the
    /// delete reply template and the index errors).
    fn golden() -> Value {
        serde_json::from_str(include_str!("golden/memory.json")).unwrap()
    }

    #[test]
    fn list_replies_read_as_pages_with_archived_entries_unaddressable() {
        let golden = golden();
        let pages: Vec<_> = golden["pages"].as_array().unwrap().iter().map(|p| page_of(p["text"].as_str().unwrap().to_owned()).unwrap()).collect();
        let tabs = MemoryEntry { id: 1, index_revision: "rev-1".into(), summary: "Prefers tabs".into() };
        let lines = MemoryEntry { id: 2, index_revision: "rev-1".into(), summary: "Line one\nLine two 한글".into() };
        let archived = MemoryEntry { id: 0, index_revision: String::new(), summary: "Archived".into() };
        assert_eq!(pages[0], MemoryPage { entries: vec![tabs.clone(), lines.clone()], next_offset: Some(2) });
        assert_eq!(pages[1], MemoryPage { entries: vec![tabs, lines, archived], next_offset: None });
        assert_eq!(pages[2], MemoryPage { entries: vec![], next_offset: None });
    }

    #[test]
    fn delete_replies_map_to_deleted_stale_or_the_runtimes_own_words() {
        let replies: Vec<String> =
            golden()["deletes"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_owned()).collect();
        assert_eq!(outcome_of(replies[0].clone()), Ok(DeleteOutcome::Deleted));
        assert_eq!(outcome_of(replies[1].clone()), Ok(DeleteOutcome::StaleRevision));
        assert_eq!(outcome_of(replies[2].clone()), Err(RoomError::Port(replies[2].clone())));
        assert_eq!(outcome_of(replies[3].clone()), Err(RoomError::Port("The agent memory entry could not be deleted.".into())));
        assert_eq!(page_of(String::new()), Err(RoomError::Port("The agent memory could not be read.".into())));
    }
}
