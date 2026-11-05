//! `MemoryControl` over the memory runtime's `memory` tool, called as the host acting for the
//! user (no `memory_caller`): it may list and delete any agent's pool and has no way to write
//! one, because this type only ever sends `list` and `delete`.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use async_trait::async_trait;
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
}

impl RuntimeMemoryControl {
    pub fn new(db: Arc<Db>, data_dir: PathBuf, snapshot_revision: Arc<AtomicU64>) -> Self {
        Self { db, data_dir, snapshot_revision }
    }

    async fn call(&self, args: Value) -> String {
        let ctx = CoreContext {
            db: &self.db,
            data_dir: &self.data_dir,
            session_cwd: None,
            snapshot_revision: &self.snapshot_revision,
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
        let page: Value = serde_json::from_str(&text).map_err(|_| {
            RoomError::Port(if text.is_empty() { "The agent memory could not be read.".into() } else { text })
        })?;
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

    async fn delete(&self, agent_id: &str, id: u64, index_revision: &str) -> Result<DeleteOutcome, RoomError> {
        let text = self
            .call(json!({ "op": "delete", "agent_id": agent_id, "id": id, "index_revision": index_revision }))
            .await;
        if text.starts_with(DELETED) {
            Ok(DeleteOutcome::Deleted)
        } else if text.contains(STALE) {
            Ok(DeleteOutcome::StaleRevision)
        } else {
            Err(RoomError::Port(if text.is_empty() { "The agent memory entry could not be deleted.".into() } else { text }))
        }
    }
}
