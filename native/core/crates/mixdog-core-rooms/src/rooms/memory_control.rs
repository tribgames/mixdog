//! `MemoryControl` over the memory runtime's `memory` tool, called as the host acting for the
//! user (no `memory_caller`): it may list and delete any agent's pool and has no way to write
//! one, because this type only ever sends `list` and `delete`.

use async_trait::async_trait;
use mixdog_services::memory::core::action::ControlScope;
use serde_json::{Value, json};

use super::RoomError;
use super::memory::{DeleteOutcome, MemoryControl, MemoryEntry, MemoryPage};

const DELETED: &str = "core deleted ";
/// The sentence the memory runtime answers a delete whose list version moved on with.
const STALE: &str = "memory indices changed";

/// Each list or delete is one operation the memory runtime owns from acceptance to completion ([`ControlScope`]): the memory stop drains or revokes
/// it, and a call after that stop began is refused before it touches the database.
pub struct RuntimeMemoryControl {
    control: ControlScope,
}

impl RuntimeMemoryControl {
    /// Over the stack's memory-control operation (`MemoryStack::memory_control`).
    pub fn scoped(control: ControlScope) -> Self {
        Self { control }
    }

    /// The `memory` op runner's reply text for `args` (errors included, as text).
    pub async fn call(&self, args: Value) -> String {
        self.control.call(args).await
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

    fn entry(id: u64, revision: &str, summary: &str) -> MemoryEntry {
        MemoryEntry { id, index_revision: revision.into(), summary: summary.into() }
    }

    #[test]
    fn a_list_reply_reads_as_a_page_with_its_next_offset() {
        let text = json!({ "entries": [
            { "id": 1, "index_revision": "rev-1", "summary": "Prefers tabs" },
            { "id": 2, "index_revision": "rev-1", "summary": "Line one\nLine two 한글" },
        ], "nextOffset": 2 })
        .to_string();
        assert_eq!(
            page_of(text),
            Ok(MemoryPage { entries: vec![entry(1, "rev-1", "Prefers tabs"), entry(2, "rev-1", "Line one\nLine two 한글")], next_offset: Some(2) })
        );
    }

    #[test]
    fn an_archived_entry_has_no_id_or_revision_so_no_delete_accepts_it_and_the_last_page_has_no_next_offset() {
        let text = json!({ "entries": [{ "id": 1, "index_revision": "rev-1", "summary": "Prefers tabs" }, { "index_revision": null, "summary": "Archived" }] }).to_string();
        assert_eq!(page_of(text), Ok(MemoryPage { entries: vec![entry(1, "rev-1", "Prefers tabs"), entry(0, "", "Archived")], next_offset: None }));
        assert_eq!(page_of(json!({ "entries": [] }).to_string()), Ok(MemoryPage { entries: vec![], next_offset: None }));
    }

    #[test]
    fn a_list_reply_that_is_not_a_page_is_the_runtimes_own_words_or_a_fixed_sentence_when_empty() {
        assert_eq!(page_of("memory is stopping".into()), Err(RoomError::Port("memory is stopping".into())));
        assert_eq!(page_of(String::new()), Err(RoomError::Port("The agent memory could not be read.".into())));
    }

    #[test]
    fn a_delete_reply_maps_to_deleted_a_moved_list_version_or_the_runtimes_own_words() {
        assert_eq!(outcome_of("core deleted 12".into()), Ok(DeleteOutcome::Deleted));
        assert_eq!(outcome_of("memory indices changed: reload the list".into()), Ok(DeleteOutcome::StaleRevision));
        assert_eq!(outcome_of("no such entry".into()), Err(RoomError::Port("no such entry".into())));
        assert_eq!(outcome_of(String::new()), Err(RoomError::Port("The agent memory entry could not be deleted.".into())));
    }
}