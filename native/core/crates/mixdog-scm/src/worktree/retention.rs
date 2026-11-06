//! Who keeps a managed worktree: the session layer says which sessions are live and which the
//! store still keeps; the registry's leases say which runtimes hold one. The two are read once
//! into a [`SnapshotRetention`], so a list or a prune decides on one consistent view.

use std::collections::HashSet;

use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::worktree::manager::Retention;
use crate::worktree::manager::Worktrees;
use crate::worktree::registry::WorktreeRecord;

pub struct SnapshotRetention {
    live_sessions: HashSet<String>,
    retained_sessions: HashSet<String>,
    /// Entries a running runtime holds through a lease.
    leased: HashSet<String>,
}

impl Retention for SnapshotRetention {
    fn owner_live(&self, record: &WorktreeRecord) -> bool {
        record
            .owner_session_id
            .as_ref()
            .is_some_and(|owner| self.live_sessions.contains(owner))
            || self.leased.contains(&record.id)
    }

    fn retained(&self, record: &WorktreeRecord) -> bool {
        record
            .owner_session_id
            .iter()
            .chain(record.shared_session_ids.iter())
            .any(|session| self.retained_sessions.contains(session))
    }
}

impl Worktrees {
    /// The view of who keeps what, now. `live` and `retained` are the session layer's.
    pub async fn retention(
        &self,
        live: HashSet<String>,
        retained: HashSet<String>,
        cancel: &CancellationToken,
    ) -> Result<SnapshotRetention, ScmFailure> {
        let mut leased = HashSet::new();
        for record in self.all_records(cancel).await? {
            if self.owner_live(&record, cancel).await? {
                leased.insert(record.id.clone());
            }
        }
        Ok(SnapshotRetention {
            live_sessions: live,
            retained_sessions: retained,
            leased,
        })
    }
}

/// A ready record at `path` for tests of the modules that read records.
#[cfg(test)]
pub(crate) fn test_record(path: &std::path::Path) -> WorktreeRecord {
    WorktreeRecord {
        id: "w".into(),
        repo_common_dir: "/r/.git".into(),
        project_path: "/r".into(),
        path: path.to_string_lossy().into_owned(),
        branch: Some("w".into()),
        base_commit: None,
        created_at: 0,
        owner_session_id: None,
        state: "ready".into(),
        merge_target: None,
        shared_session_ids: Vec::new(),
        extra: Default::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(owner: Option<&str>, shared: &[&str]) -> WorktreeRecord {
        WorktreeRecord {
            id: "w".into(),
            repo_common_dir: "/r/.git".into(),
            project_path: "/r".into(),
            path: "/w".into(),
            branch: Some("w".into()),
            base_commit: None,
            created_at: 0,
            owner_session_id: owner.map(str::to_owned),
            state: "ready".into(),
            merge_target: None,
            shared_session_ids: shared.iter().map(|s| (*s).to_owned()).collect(),
            extra: Default::default(),
        }
    }

    #[test]
    fn a_session_the_store_keeps_retains_and_a_live_session_or_lease_holds() {
        let view = SnapshotRetention {
            live_sessions: ["a".to_owned()].into(),
            retained_sessions: ["b".to_owned()].into(),
            leased: ["x".to_owned()].into(),
        };
        assert!(view.owner_live(&record(Some("a"), &[])));
        assert!(!view.owner_live(&record(Some("c"), &[])));
        assert!(view.retained(&record(Some("c"), &["b"])));
        assert!(!view.retained(&record(None, &[])));
        let mut leased = record(Some("c"), &[]);
        leased.id = "x".into();
        assert!(view.owner_live(&leased));
    }
}
