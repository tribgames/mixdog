//! The periodic idle-session sweep (Node `session/manager/idle-cleanup.mjs` `startIdleCleanup`
//! driving `store/sweep/stale-sweep.mjs`, `sweep-row.mjs`, `sweep-finish.mjs`).
//!
//! Every five minutes, first after one interval, the sweep reads every stored session and gives
//! each its verdict: a mature tombstone is deleted, a blank user scratch is deleted once cold,
//! an ownerless idle session is closed, and the resumable open ones are capped (older than
//! fourteen days or beyond three hundred are deleted, newest kept first). A home or room session
//! is permanent. A session with a live runtime is never touched, and a record the store cannot
//! read is never swept: the store answers `Err` for the whole listing and nothing happens.
//!
//! After the verdicts, a session scratch folder whose session is not stored any more is removed
//! (`SweepStore::reap_scratch`; Node had no such step and kept those folders for good).
//!
//! What this port leaves to others: the sub-agent tree retention (three days archive, seven
//! delete; `sub-agent-retention.mjs`) is `session_retention`'s; the summary-index repair, the
//! legacy `.hb`/`.own` marker reap and the compaction-archive orphan reap have no counterpart
//! because the Rust store holds no summary index and writes none of those sidecars.

use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::is_room_thread_session_id;
use tokio_util::sync::CancellationToken;

/// `CLEANUP_INTERVAL_MS`, and the delay before the first cycle (`CLEANUP_INITIAL_DELAY_MS`).
pub const CLEANUP_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// `TOMBSTONE_MAX_AGE_MS`.
const TOMBSTONE_MAX_AGE_MS: i64 = 60 * 60 * 1000;
/// `DEFAULT_SESSION_TTL_MS`: the idle time after which an ownerless session is closed.
const IDLE_TTL_MS: i64 = 5 * 60 * 1000;
/// `RUNNING_STALL_MS`: a `running` session is a zombie once silent this long.
const RUNNING_STALL_MS: i64 = 10 * 60 * 1000;
/// `RESUMABLE_OPEN_MAX_AGE_MS`.
const OPEN_MAX_AGE_MS: i64 = 14 * 24 * 60 * 60 * 1000;
/// `RESUMABLE_OPEN_MAX_COUNT`.
const OPEN_MAX_COUNT: usize = 300;
/// `BLANK_SCRATCH_MAX_AGE_MS`.
const BLANK_SCRATCH_MAX_AGE_MS: i64 = 60 * 60 * 1000;

/// One stored session as the sweep reads it: the authoritative record fields, not an index row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SweepRow {
    pub id: String,
    /// The record's `owner`; empty for an ownerless legacy session.
    pub owner: String,
    pub status: String,
    /// `closed === true`.
    pub closed: bool,
    pub updated_at: i64,
    pub last_heartbeat_at: i64,
    pub created_at: i64,
    /// The record file's modification time.
    pub record_mtime: i64,
    /// User and assistant messages in the conversation.
    pub conversation_count: u64,
    /// The session's last conversation turn as this pass read it (`subAgentActivityAt`, epoch ms):
    /// the baseline the store's admission compares against when the mutation lands.
    pub activity: i64,
}

/// What the sweep needs from the session store and runtime.
#[async_trait]
pub trait SweepStore: Send + Sync {
    /// Every stored session. `Err` when the store cannot be read: nothing is swept then.
    async fn rows(&self) -> Result<Vec<SweepRow>, String>;
    /// `markSessionClosed(id, 'idle-sweep')`. The store's own admission decides, in the one step
    /// that lands the mutation, whether the session is busy, attached, has pending work or moved
    /// since `row.activity`: then `Ok(false)` and the row is kept for the next pass.
    async fn close_idle(&self, row: &SweepRow) -> Result<bool, String>;
    /// `deleteSession(id)`, admitted the same way: `Ok(false)` when nothing was deleted.
    async fn delete(&self, row: &SweepRow) -> Result<bool, String>;
    /// The session owns a non-closed runtime entry (`_isSessionLive`). Only the verdict's input:
    /// a mutation never relies on it.
    fn is_live(&self, id: &str) -> bool;
    /// Removes the session scratch folders whose session is known not to exist. What the store
    /// lists is the store's to say, not the pass's: a session the pass could not judge still
    /// exists. A store without scratch folders does nothing.
    async fn reap_scratch(&self) {}
}

/// What one pass did (`sweepStaleSessions`' tally).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Tally {
    pub cleaned: Vec<String>,
    pub remaining: usize,
    pub tombstones_cleaned: Vec<String>,
    pub tombstone_errors: Vec<(String, String)>,
    pub open_pruned: Vec<String>,
}

enum Verdict {
    Keep,
    /// An open session that takes part in the resumable-open cap.
    Candidate(i64),
    CloseIdle,
    DeleteTombstone,
    DeleteScratch,
}

fn permanent(id: &str) -> bool {
    agent_id_of_home_session(id).is_some() || is_room_thread_session_id(id)
}

fn verdict(row: &SweepRow, now: i64, live: bool) -> Verdict {
    if row.closed || row.status == "closed" {
        // Maturity is the original close time, never the file's. A home or room session's
        // tombstone matures like any other: only an open one is permanent.
        let mature = !live && now - row.updated_at >= TOMBSTONE_MAX_AGE_MS;
        return if mature { Verdict::DeleteTombstone } else { Verdict::Keep };
    }
    if permanent(&row.id) {
        return Verdict::Keep;
    }
    let owned = !row.owner.is_empty();
    let newest = row.updated_at.max(row.last_heartbeat_at).max(row.created_at).max(row.record_mtime);
    if newest > 0 && now - newest <= IDLE_TTL_MS {
        return if owned { Verdict::Keep } else { Verdict::Candidate(newest) };
    }
    if owned {
        // A user conversation is never closed or capped; only a cold blank scratch goes.
        let last_active = row.updated_at.max(row.last_heartbeat_at).max(row.created_at);
        let blank = row.conversation_count == 0 && now - last_active > BLANK_SCRATCH_MAX_AGE_MS && !live;
        return if blank { Verdict::DeleteScratch } else { Verdict::Keep };
    }
    if live {
        return Verdict::Keep;
    }
    let last_active = [row.last_heartbeat_at, row.updated_at, row.created_at].into_iter().find(|t| *t > 0).unwrap_or(0);
    if row.status == "running" && now - last_active <= RUNNING_STALL_MS {
        return Verdict::Keep;
    }
    if now - last_active > IDLE_TTL_MS { Verdict::CloseIdle } else { Verdict::Candidate(last_active) }
}

/// One pass over the store (`sweepStaleSessionSteps` with `sweepIdle`, tombstones on and the
/// open-session cap on).
pub async fn sweep_once(store: &dyn SweepStore, now: i64) -> Result<Tally, String> {
    let rows = store.rows().await?;
    let mut tally = Tally::default();
    let mut candidates: Vec<(&SweepRow, i64)> = Vec::new();
    for row in &rows {
        // The scan and the runtime are not atomic: whether work started since this verdict is the
        // store's admission decision when the mutation lands (`Ok(false)`), not a second read here.
        match verdict(row, now, store.is_live(&row.id)) {
            Verdict::Keep => tally.remaining += 1,
            Verdict::Candidate(last_active) => {
                candidates.push((row, last_active));
                tally.remaining += 1;
            }
            Verdict::CloseIdle => match store.close_idle(row).await {
                Ok(true) => tally.cleaned.push(row.id.clone()),
                Ok(false) => tally.remaining += 1,
                Err(error) => mixdog_rt::node_stderr!("[session-store] idle-sweep close failed for {}: {error}", row.id),
            },
            Verdict::DeleteTombstone => match store.delete(row).await {
                Ok(true) => tally.tombstones_cleaned.push(row.id.clone()),
                Ok(false) => tally.remaining += 1,
                Err(error) => {
                    tally.tombstone_errors.push((row.id.clone(), error));
                    tally.remaining += 1;
                }
            },
            Verdict::DeleteScratch => match store.delete(row).await {
                Ok(true) => tally.open_pruned.push(row.id.clone()),
                _ => tally.remaining += 1,
            },
        }
    }
    prune_open(store, now, candidates, &mut tally).await;
    store.reap_scratch().await;
    Ok(tally)
}

/// `pruneOpenCandidates`: newest first; a live session is kept and still takes a slot.
async fn prune_open(store: &dyn SweepStore, now: i64, mut candidates: Vec<(&SweepRow, i64)>, tally: &mut Tally) {
    candidates.sort_by_key(|row| std::cmp::Reverse(row.1));
    let mut kept = 0usize;
    for (row, last_active) in candidates {
        let too_old = now - last_active > OPEN_MAX_AGE_MS;
        if store.is_live(&row.id) || (!too_old && kept < OPEN_MAX_COUNT) {
            kept += 1;
            continue;
        }
        match store.delete(row).await {
            Ok(true) => {
                tally.open_pruned.push(row.id.clone());
                tally.remaining = tally.remaining.saturating_sub(1);
            }
            _ => kept += 1,
        }
    }
}

fn now_ms() -> i64 {
    mixdog_rt::wall_clock!().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
}
/// `startIdleCleanup`: one cycle per interval, the first after one interval, a cycle never
/// overlapping the next. Returns once `stop` is cancelled. Needs the proof that startup (the
/// ownership lock, the prior-owner verdict, the claim barrier, the migration) has finished: no
/// sweep may touch a data directory before then.
pub async fn run(_started: crate::startup::Started, store: Arc<dyn SweepStore>, interval: Duration, stop: CancellationToken) {
    loop {
        let due = mixdog_rt::ticker().wait_until(Instant::now() + interval);
        tokio::select! {
            () = stop.cancelled() => return,
            () = due => {}
        }
        match sweep_once(store.as_ref(), now_ms()).await {
            Ok(tally) if !tally.cleaned.is_empty() || !tally.tombstones_cleaned.is_empty() || !tally.open_pruned.is_empty() => {
                tracing::debug!(
                    closed = tally.cleaned.len(),
                    tombstones = tally.tombstones_cleaned.len(),
                    pruned = tally.open_pruned.len(),
                    remaining = tally.remaining,
                    "idle sweep"
                );
            }
            Ok(_) => {}
            Err(error) => mixdog_rt::node_stderr!("[agent-session] idle sweep error: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {

    use super::*;

    const NOW: i64 = 10_000_000_000;

    #[tokio::test]
    async fn an_unreadable_store_is_not_swept() {
        struct Broken;
        #[async_trait]
        impl SweepStore for Broken {
            async fn rows(&self) -> Result<Vec<SweepRow>, String> {
                Err("EACCES".into())
            }
            async fn close_idle(&self, _: &SweepRow) -> Result<bool, String> {
                unreachable!()
            }
            async fn delete(&self, _: &SweepRow) -> Result<bool, String> {
                unreachable!()
            }
            fn is_live(&self, _: &str) -> bool {
                false
            }
        }
        assert_eq!(sweep_once(&Broken, NOW).await.unwrap_err(), "EACCES");
    }
}
