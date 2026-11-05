//! Read-only snapshot worktrees held by a session (the Lead's turn snapshots and a delegated
//! worker's `git worktree add --detach`): each is held by its session and removed when that
//! turn settles. A command running inside one holds a lease; a snapshot with a lease is never
//! removed, and one being removed admits no new command.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::locks::path_key;
use crate::worktree::errors;
use crate::worktree::manager::Worktrees;
use crate::worktree::manager::entry_json;

const RETRY_MS: u64 = 2_000;
const RETRY_LIMIT: u32 = 5;

#[derive(Default)]
struct Held {
    path: PathBuf,
    leases: u32,
    removing: bool,
}

/// Who holds which snapshot, in memory: a snapshot never outlives its holder, and a restart
/// leaves the rest to the prune.
#[derive(Default)]
pub struct SnapshotLedger {
    turns: Mutex<HashMap<String, HashSet<String>>>,
    held: Mutex<HashMap<String, Held>>,
    sequence: AtomicU64,
}

/// A command's hold on a snapshot; dropping it releases the hold.
pub struct SnapshotLease {
    ledger: Option<(Arc<SnapshotLedger>, String)>,
}

impl Drop for SnapshotLease {
    fn drop(&mut self) {
        if let Some((ledger, id)) = self.ledger.take() {
            if let Some(held) = ledger.held.lock().expect("snapshot ledger").get_mut(&id) {
                held.leases = held.leases.saturating_sub(1);
            }
        }
    }
}

impl SnapshotLedger {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    pub(crate) fn register(&self, id: &str, path: &Path) {
        self.held.lock().expect("snapshot ledger").entry(id.to_owned()).or_default().path = path.to_path_buf();
    }

    pub(crate) fn forget(&self, id: &str) {
        self.held.lock().expect("snapshot ledger").remove(id);
    }

    /// The snapshot folder `repo` lies in.
    pub fn containing(&self, repo: &Path) -> Option<(String, PathBuf)> {
        let wanted = path_key(repo);
        self.held
            .lock()
            .expect("snapshot ledger")
            .iter()
            .find(|(_, held)| {
                let root = path_key(&held.path);
                wanted == root || wanted.starts_with(&format!("{root}/"))
            })
            .map(|(id, held)| (id.clone(), held.path.clone()))
    }

    /// A lease for a command running in `repo`; `Err` while that snapshot is being removed.
    /// Outside any snapshot the lease holds nothing.
    pub fn admit(self: &Arc<Self>, repo: &Path) -> Result<SnapshotLease, ()> {
        let Some((id, _)) = self.containing(repo) else {
            return Ok(SnapshotLease { ledger: None });
        };
        let mut held = self.held.lock().expect("snapshot ledger");
        let Some(entry) = held.get_mut(&id) else {
            return Ok(SnapshotLease { ledger: None });
        };
        if entry.removing {
            return Err(());
        }
        entry.leases += 1;
        Ok(SnapshotLease {
            ledger: Some((self.clone(), id)),
        })
    }

    /// Marks the snapshot as being removed unless a command holds it.
    pub(crate) fn begin_removal(&self, id: &str) -> bool {
        match self.held.lock().expect("snapshot ledger").get_mut(id) {
            Some(held) if held.leases > 0 => false,
            Some(held) => {
                held.removing = true;
                true
            }
            None => true,
        }
    }

    pub(crate) fn end_removal(&self, id: &str) {
        if let Some(held) = self.held.lock().expect("snapshot ledger").get_mut(id) {
            held.removing = false;
        }
    }

    fn note_turn(&self, session: &str, tx: &str) {
        self.turns
            .lock()
            .expect("snapshot ledger")
            .entry(session.to_owned())
            .or_default()
            .insert(tx.to_owned());
    }

    fn take_turns(&self, session: &str) -> Vec<String> {
        self.turns
            .lock()
            .expect("snapshot ledger")
            .remove(session)
            .map(|set| set.into_iter().collect())
            .unwrap_or_default()
    }
}

impl Worktrees {
    /// A snapshot of `commit` held by worker `session_id` until its turn settles.
    pub async fn create_worker_snapshot(
        &self,
        session_id: &str,
        project: &Path,
        commit: &str,
        tx_id: &str,
        confirm_large: bool,
        cancel: &CancellationToken,
    ) -> Result<Value, ScmFailure> {
        let session = session_id.trim();
        if session.is_empty() {
            return Err(ScmFailure::invalid("sessionId", "the worker session"));
        }
        let ledger = self.ledger();
        let tx = match tx_id.trim() {
            "" => format!(
                "worker-snapshot-{}-{}",
                std::process::id(),
                ledger.sequence.fetch_add(1, Ordering::Relaxed)
            ),
            given => given.to_owned(),
        };
        let record = self.snapshot(project, session, commit, &tx, confirm_large, cancel).await?;
        ledger.register(&record.id, Path::new(&record.path));
        ledger.note_turn(session, &tx);
        Ok(entry_json(&record))
    }

    /// Removes one snapshot unless a command still runs in it.
    pub async fn remove_snapshot(&self, id: &str, force: bool, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let ledger = self.ledger();
        if !ledger.begin_removal(id) {
            return Err(errors::busy_with("snapshot-held", None, Some(id.to_owned()), None));
        }
        let outcome = self.remove(id, force, None, cancel).await;
        ledger.end_removal(id);
        if outcome.is_ok() {
            ledger.forget(id);
        }
        outcome
    }

    /// The worker's turn settled: removes the snapshots it made. One a command still runs in is
    /// retried with a doubling delay a few times; the rest stays for the prune.
    pub async fn release_worker_snapshots(
        &self,
        session_id: &str,
        retry_ms: Option<u64>,
        cancel: &CancellationToken,
    ) -> Result<Value, ScmFailure> {
        let made = self.ledger().take_turns(session_id);
        let (mut removed, mut kept) = (Vec::<Value>::new(), Vec::<Value>::new());
        let mut pending = made;
        for attempt in 0..RETRY_LIMIT {
            if pending.is_empty() {
                break;
            }
            if attempt > 0 {
                let wait = retry_ms.unwrap_or(RETRY_MS) * 2u64.pow(attempt - 1);
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(wait)) => {}
                    _ = cancel.cancelled() => return Err(ScmFailure::Cancelled),
                }
            }
            kept.clear();
            let mut again = Vec::new();
            for tx in pending {
                let found = self
                    .snapshot_of(session_id, &tx, cancel)
                    .await?;
                let Some(id) = found else { continue };
                match self.remove_snapshot(&id, true, cancel).await {
                    Ok(_) => removed.push(json!(id)),
                    Err(failure) if failure.code() == Some(errors::WORKTREE_BUSY_JOBS) => {
                        kept.push(json!({ "id": id, "txId": tx, "reason": "in-use" }));
                        again.push(tx);
                    }
                    Err(failure) => kept.push(json!({ "id": id, "txId": tx, "reason": failure.code().unwrap_or("error") })),
                }
            }
            pending = again;
        }
        Ok(json!({ "removed": removed, "kept": kept }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_leased_snapshot_is_not_removable_and_a_removed_one_admits_nothing() {
        let ledger = SnapshotLedger::new();
        ledger.register("snap", Path::new("/data/worktrees-v1/h/snap"));
        assert_eq!(ledger.containing(Path::new("/data/worktrees-v1/h/snap/sub")).unwrap().0, "snap");
        assert!(ledger.containing(Path::new("/data/worktrees-v1/h/other")).is_none());
        let lease = ledger.admit(Path::new("/data/worktrees-v1/h/snap")).unwrap();
        assert!(!ledger.begin_removal("snap"));
        drop(lease);
        assert!(ledger.begin_removal("snap"));
        assert!(ledger.admit(Path::new("/data/worktrees-v1/h/snap")).is_err());
        ledger.end_removal("snap");
        assert!(ledger.admit(Path::new("/elsewhere")).is_ok());
    }
}
