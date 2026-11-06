//! An agent's own memory pool for its profile ("이 에이전트가 기억하는 것"). The host reads and
//! deletes it, acting for the user; it never writes one: `MemoryControl` has no write method, so
//! the prohibition lives in the type. A deleted agent's pool is retained, unreferenced, until its
//! entries are deleted here. Calls for one agent run one at a time; other agents are independent.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_rt::KeyedChains;
use serde::{Deserialize, Serialize};

use super::RoomError;
use mixdog_core_base::rooms::ids::agent_home_session_id;

const PAGE_SIZE: u32 = 100;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: u64,
    pub index_revision: String,
    pub summary: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryPage {
    pub entries: Vec<MemoryEntry>,
    pub next_offset: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeleteOutcome {
    Deleted,
    /// The list moved on since the caller read it.
    StaleRevision,
}

/// The memory runtime as the host may use it: list and delete, never write.
#[async_trait]
pub trait MemoryControl: Send + Sync {
    async fn list(&self, agent_id: &str, offset: u32, limit: u32) -> Result<MemoryPage, RoomError>;
    async fn delete(&self, agent_id: &str, id: u64, index_revision: &str) -> Result<DeleteOutcome, RoomError>;
}

pub struct AgentMemory<C: MemoryControl> {
    control: C,
    serial: Arc<KeyedChains>,
}

fn required_agent_id(agent_id: &str) -> Result<(), RoomError> {
    agent_home_session_id(agent_id)
        .map(|_| ())
        .ok_or_else(|| RoomError::Invalid("agent id is invalid.".into()))
}

/// A delete's input: a positive list index and its list version.
pub fn required_entry_ref(id: u64, index_revision: &str) -> Result<(), RoomError> {
    if id == 0 {
        return Err(RoomError::Invalid("memory id is invalid.".into()));
    }
    if index_revision.is_empty() || mixdog_js::utf16_len(index_revision) > 200 {
        return Err(RoomError::Invalid("memory indexRevision is invalid.".into()));
    }
    Ok(())
}

impl<C: MemoryControl> AgentMemory<C> {
    pub fn new(control: C) -> Self {
        Self { control, serial: KeyedChains::new() }
    }

    /// `agent/memory/list`: every active entry of the agent's pool, in its list order.
    pub async fn list(&self, agent_id: &str) -> Result<Vec<MemoryEntry>, RoomError> {
        required_agent_id(agent_id)?;
        let _turn = self.serial.acquire(agent_id).await;
        let mut entries = Vec::new();
        let mut offset = 0;
        loop {
            let page = self.control.list(agent_id, offset, PAGE_SIZE).await?;
            entries.extend(page.entries);
            match page.next_offset {
                Some(next) if next > offset => offset = next,
                _ => return Ok(entries),
            }
        }
    }

    /// `agent/memory/delete`: a stale `index_revision` is refused (`PreconditionFailed`; list again).
    pub async fn delete(&self, agent_id: &str, id: u64, index_revision: &str) -> Result<(), RoomError> {
        required_agent_id(agent_id)?;
        required_entry_ref(id, index_revision)?;
        let _turn = self.serial.acquire(agent_id).await;
        match self.control.delete(agent_id, id, index_revision).await? {
            DeleteOutcome::Deleted => Ok(()),
            DeleteOutcome::StaleRevision => Err(RoomError::PreconditionFailed(
                "The agent memory changed since it was listed; list it again.".into(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Fake {
        entries: Mutex<Vec<MemoryEntry>>,
        revision: Mutex<String>,
    }

    #[async_trait]
    impl MemoryControl for Fake {
        async fn list(&self, _agent: &str, offset: u32, limit: u32) -> Result<MemoryPage, RoomError> {
            let all = self.entries.lock().unwrap();
            let page: Vec<_> = all.iter().skip(offset as usize).take(limit as usize).cloned().collect();
            let end = offset + page.len() as u32;
            Ok(MemoryPage { entries: page, next_offset: (end < all.len() as u32).then_some(end) })
        }
        async fn delete(&self, _agent: &str, id: u64, revision: &str) -> Result<DeleteOutcome, RoomError> {
            if *self.revision.lock().unwrap() != revision {
                return Ok(DeleteOutcome::StaleRevision);
            }
            self.entries.lock().unwrap().retain(|e| e.id != id);
            *self.revision.lock().unwrap() = "rev2".into();
            Ok(DeleteOutcome::Deleted)
        }
    }

    fn memory(count: u64) -> AgentMemory<Fake> {
        let entries = (1..=count)
            .map(|id| MemoryEntry { id, index_revision: "rev1".into(), summary: format!("m{id}") })
            .collect();
        AgentMemory::new(Fake { entries: Mutex::new(entries), revision: Mutex::new("rev1".into()) })
    }

    #[tokio::test]
    async fn lists_every_page() {
        let memory = memory(250);
        let listed = memory.list("gh").await.unwrap();
        assert_eq!(listed.len(), 250);
        assert_eq!(listed[249].summary, "m250");
    }

    #[tokio::test]
    async fn a_stale_revision_is_a_precondition_failure_and_deletes_nothing() {
        let memory = memory(3);
        memory.delete("gh", 1, "rev1").await.unwrap();
        let error = memory.delete("gh", 2, "rev1").await.unwrap_err();
        assert!(matches!(error, RoomError::PreconditionFailed(_)));
        assert_eq!(memory.list("gh").await.unwrap().len(), 2);
        memory.delete("gh", 2, "rev2").await.unwrap();
        assert_eq!(memory.list("gh").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn inputs_are_validated() {
        let memory = memory(1);
        assert!(matches!(memory.list("Bad Id").await, Err(RoomError::Invalid(_))));
        assert!(matches!(memory.delete("gh", 0, "rev1").await, Err(RoomError::Invalid(_))));
        assert!(matches!(memory.delete("gh", 1, "").await, Err(RoomError::Invalid(_))));
        assert!(matches!(memory.delete("gh", 1, &"x".repeat(201)).await, Err(RoomError::Invalid(_))));
    }
}
