//! The `agentPool` section: its published state is the only source of the pool. Workers publish
//! their own entries; clients converge from `agent/pool/updated` and never poll.
//! `agent/pool/list` is a snapshot read of the same state and does not refresh it.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolEntry {
    pub session_id: String,
    pub agent_id: String,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PoolSnapshot {
    pub revision: u64,
    pub entries: Vec<PoolEntry>,
}

#[derive(Default)]
struct Inner {
    revision: u64,
    entries: BTreeMap<String, PoolEntry>,
}

/// Held only for the map update itself; reads clone a small snapshot.
#[derive(Default)]
pub struct AgentPool {
    inner: Mutex<Inner>,
}

impl AgentPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// A worker session published its entry. The new snapshot when the pool changed, `None` when
    /// the entry equals the one held (no update goes out).
    pub fn publish(&self, entry: PoolEntry) -> Option<PoolSnapshot> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.entries.get(&entry.session_id) == Some(&entry) {
            return None;
        }
        inner.entries.insert(entry.session_id.clone(), entry);
        Some(Self::bump(&mut inner))
    }

    /// A worker session ended.
    pub fn withdraw(&self, session_id: &str) -> Option<PoolSnapshot> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.entries.remove(session_id)?;
        Some(Self::bump(&mut inner))
    }

    fn bump(inner: &mut Inner) -> PoolSnapshot {
        inner.revision += 1;
        PoolSnapshot { revision: inner.revision, entries: inner.entries.values().cloned().collect() }
    }

    /// `agent/pool/list`.
    pub fn snapshot(&self) -> PoolSnapshot {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        PoolSnapshot { revision: inner.revision, entries: inner.entries.values().cloned().collect() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(session: &str, status: &str) -> PoolEntry {
        PoolEntry { session_id: session.into(), agent_id: "gh".into(), status: status.into() }
    }

    #[test]
    fn a_client_converges_from_updates_alone() {
        let pool = AgentPool::new();
        let mut view = pool.snapshot();
        let mut apply = |update: Option<PoolSnapshot>| {
            if let Some(update) = update {
                view = update;
            }
        };
        apply(pool.publish(entry("s1", "running")));
        apply(pool.publish(entry("s2", "idle")));
        apply(pool.publish(entry("s1", "idle")));
        apply(pool.withdraw("s2"));
        assert_eq!(view, pool.snapshot());
        assert_eq!(view.entries, [entry("s1", "idle")]);
        assert_eq!(view.revision, 4);
    }

    #[test]
    fn unchanged_publishes_and_unknown_withdrawals_send_nothing() {
        let pool = AgentPool::new();
        pool.publish(entry("s1", "running"));
        assert_eq!(pool.publish(entry("s1", "running")), None);
        assert_eq!(pool.withdraw("zzz"), None);
        assert_eq!(pool.snapshot().revision, 1);
    }
}
