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

/// How a snapshot cleanup retries the removals a command still runs in: the first delay, the
/// number of attempts, and (when set) the doubling stops after that many steps. Node has two
/// cleanups with different schedules, and each keeps its own.
#[derive(Clone, Copy)]
struct Retry {
    ms: u64,
    limit: u32,
    cap_steps: Option<u32>,
}

impl Retry {
    /// A worker's turn (`worker-snapshots.mjs`): `RETRY_MS` 2_000 and `RETRY_LIMIT` 5 (lines 13-14),
    /// `retryMs * 2 ** (attempt - 1)` with no cap (line 73): 2 + 4 + 8 + 16 = 30 s.
    const WORKER: Retry = Retry { ms: 2_000, limit: 5, cap_steps: None };
    /// The Lead's turn (`transitions.mjs` `snapshotRetryMs = 2_000`, `snapshotRetryLimit = 20`,
    /// lines 164-165; `side-checkouts.mjs` `SNAPSHOT_BACKOFF_STEPS = 5` line 11 and
    /// `snapshotRetryMs * 2 ** Math.min(attempt - 1, SNAPSHOT_BACKOFF_STEPS)` line 141):
    /// 2, 4, 8, 16, 32, 64 s, then 64 s for the rest of the 19 waits: 958 s in all.
    const TURN: Retry = Retry { ms: 2_000, limit: 20, cap_steps: Some(5) };

    /// The delay before attempt `attempt` (1-based among the retries; the first attempt has none).
    fn delay(self, attempt: u32) -> Duration {
        let steps = attempt - 1;
        let steps = self.cap_steps.map_or(steps, |cap| steps.min(cap));
        Duration::from_millis(self.ms * 2u64.pow(steps))
    }

    /// Waits it out on the tokio clock; a cancel ends the cleanup.
    async fn wait(self, attempt: u32, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        tokio::select! {
            _ = mixdog_rt::time::sleep(self.delay(attempt)) => Ok(()),
            _ = cancel.cancelled() => Err(ScmFailure::Cancelled),
        }
    }
}

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

    /// Removes every snapshot `session_id` holds (the session was deleted): `{removed, kept}`,
    /// a snapshot a command still runs in kept with `reason:"in-use"`, another failure kept with
    /// its code.
    pub async fn remove_session_snapshots(&self, session_id: &str, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let held: Vec<(String, Option<String>)> = self
            .all_records(cancel)
            .await?
            .into_iter()
            .filter(|r| {
                crate::worktree::manager::is_snapshot(r) && r.extra.get("holderSessionId").and_then(Value::as_str) == Some(session_id)
            })
            .map(|r| (r.id.clone(), r.extra.get("txId").and_then(Value::as_str).map(str::to_owned)))
            .collect();
        let (mut removed, mut kept) = (Vec::<Value>::new(), Vec::<Value>::new());
        for (id, tx) in held {
            match self.remove_snapshot(&id, true, cancel).await {
                Ok(_) => removed.push(json!(id)),
                Err(failure) if failure.code() == Some(errors::WORKTREE_BUSY_JOBS) => {
                    kept.push(json!({ "id": id, "txId": tx, "reason": "in-use" }));
                }
                Err(failure) => kept.push(json!({ "id": id, "txId": tx, "error": failure.code().unwrap_or("error") })),
            }
        }
        Ok(json!({ "removed": removed, "kept": kept }))
    }

    /// The worker's turn settled: removes the snapshots it made (`releaseWorkerSnapshots`). One a
    /// command still runs in is retried with a doubling delay, 5 attempts in all; the rest stays for
    /// the prune. `retry_ms` replaces the first delay.
    pub async fn release_worker_snapshots(
        &self,
        session_id: &str,
        retry_ms: Option<u64>,
        cancel: &CancellationToken,
    ) -> Result<Value, ScmFailure> {
        self.release_snapshots(session_id, Retry { ms: retry_ms.unwrap_or(Retry::WORKER.ms), ..Retry::WORKER }, cancel).await
    }

    /// The Lead's turn settled: the same removal as the worker's with the Lead's schedule
    /// (`removeTurnSnapshots`): up to 20 attempts, the doubling delay capped at 64 s. `retry_ms`
    /// replaces the first delay.
    pub async fn release_turn_snapshots(
        &self,
        session_id: &str,
        retry_ms: Option<u64>,
        cancel: &CancellationToken,
    ) -> Result<Value, ScmFailure> {
        self.release_snapshots(session_id, Retry { ms: retry_ms.unwrap_or(Retry::TURN.ms), ..Retry::TURN }, cancel).await
    }

    async fn release_snapshots(&self, session_id: &str, retry: Retry, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let made = self.ledger().take_turns(session_id);
        let (mut removed, mut kept) = (Vec::<Value>::new(), Vec::<Value>::new());
        let mut pending = made;
        for attempt in 0..retry.limit {
            if pending.is_empty() {
                break;
            }
            if attempt > 0 {
                retry.wait(attempt, cancel).await?;
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

    /// What Node's own cleanups waited with a snapshot that stayed busy, recorded under a fake
    /// clock (`record-snapshot-cleanup-schedule.mjs`): the Lead's `removeTurnSnapshots` and the
    /// worker's `releaseWorkerSnapshots`, each with the default first delay and with a short one.
    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../../fixtures/snapshot-cleanup-schedule/golden.json")).unwrap()
    }

    /// Runs the schedule's waits on the paused tokio clock: the attempt count it allows, and how
    /// long each wait took.
    async fn replay(retry: Retry) -> (usize, Vec<u64>) {
        let cancel = CancellationToken::new();
        let mut waits = Vec::new();
        for attempt in 1..retry.limit {
            let before = tokio::time::Instant::now();
            retry.wait(attempt, &cancel).await.unwrap();
            waits.push(before.elapsed().as_millis() as u64);
        }
        (retry.limit as usize, waits)
    }

    fn recorded(row: &Value) -> (usize, Vec<u64>) {
        (row["attempts"].as_u64().unwrap() as usize, row["waitsMs"].as_array().unwrap().iter().map(|w| w.as_u64().unwrap()).collect())
    }

    #[tokio::test(start_paused = true)]
    async fn the_leads_cleanup_waits_as_nodes_remove_turn_snapshots_does() {
        let golden = golden();
        let node = &golden["turn"];
        assert_eq!(replay(Retry::TURN).await, recorded(&node["default"]));
        let short = node["firstDelay10"]["firstDelayMs"].as_u64().unwrap();
        assert_eq!(replay(Retry { ms: short, ..Retry::TURN }).await, recorded(&node["firstDelay10"]));
    }

    #[tokio::test(start_paused = true)]
    async fn the_workers_cleanup_waits_as_nodes_release_worker_snapshots_does() {
        let golden = golden();
        let node = &golden["worker"];
        assert_eq!(replay(Retry::WORKER).await, recorded(&node["default"]));
        let short = node["firstDelay1"]["firstDelayMs"].as_u64().unwrap();
        assert_eq!(replay(Retry { ms: short, ..Retry::WORKER }).await, recorded(&node["firstDelay1"]));
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancel_ends_the_wait_at_once() {
        let cancel = CancellationToken::new();
        let waiting = tokio::spawn({
            let cancel = cancel.clone();
            async move { Retry::TURN.wait(7, &cancel).await }
        });
        mixdog_rt::time::sleep(Duration::from_secs(10)).await;
        cancel.cancel();
        assert!(matches!(waiting.await.unwrap(), Err(ScmFailure::Cancelled)));
    }
}
