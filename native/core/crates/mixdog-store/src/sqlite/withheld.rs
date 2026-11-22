use std::collections::HashSet;

use mixdog_rt::InLane;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use serde_json::Map;
use serde_json::Value;

use super::DbError;
use super::SqliteStore;

/// The table, made at every open (an index of an earlier build lacks it; it is no projection a rebuild derives, so adding
/// it moves no `user_version`).
pub(crate) const WITHHELD_DDL: &str = "CREATE TABLE IF NOT EXISTS withheld_sessions (id TEXT PRIMARY KEY) WITHOUT ROWID;";

/// The withheld sessions as the connection's read transaction sees them: read in the same transaction as the rows it decides.
pub(crate) fn withheld_in(c: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = c.prepare_cached("SELECT id FROM withheld_sessions")?;
    stmt.query_map([], |r| r.get::<_, String>(0))?.collect()
}

/// Whether `session` is withheld, in the connection's transaction.
pub(crate) fn is_withheld_in(c: &Connection, session: &str) -> rusqlite::Result<bool> {
    Ok(c.prepare_cached("SELECT 1 FROM withheld_sessions WHERE id = ?1")?.query_row([session], |_| Ok(())).optional()?.is_some())
}

/// The list-row and worker-map members that are never content: anything else (a title, a preview, a worker's task or
/// result, a member added later) is left out of a withheld session's row.
const STRUCTURAL: &[&str] = &[
    "id",
    "updatedAt",
    "lastUsedAt",
    "createdAt",
    "lastHeartbeatAt",
    "closed",
    "status",
    "owner",
    "agent",
    "sessionMode",
    "sourceType",
    "sourceName",
    "scopeKey",
    "parentSessionId",
    "ownerSessionId",
    "visibility",
    "clientHostPid",
    "hostPid",
    "cwd",
    "desktopSession",
    "workspace",
    "roomMembers",
    "provider",
    "model",
    "presetName",
    "effort",
    "fast",
    "autoEffort",
    "modelParameters",
    "agentTag",
    "tag",
    "task_id",
    "taskId",
    "permission",
    "permissionMode",
    "toolPermission",
    "schemaAllowedTools",
    "taskType",
    "messageCount",
    "compactCount",
    "realTurnCount",
    "generation",
    "storageMtimeMs",
    "storageSize",
    "detachedReason",
    "importKey",
    "inheritedFromSessionId",
    "favoriteAt",
    "retiredAt",
    "readState",
    "archivedAt",
    "state",
    "stage",
    "startedAt",
    "finishedAt",
    "cancelledAt",
    "turnStartedAt",
];

/// `map` with its content members left out.
pub(crate) fn keep_structural(map: &mut Map<String, Value>) {
    map.retain(|key, _| STRUCTURAL.contains(&key.as_str()));
}

/// A withheld session's list row: its structural members, an empty title and preview.
pub(crate) fn blank_row(row: &mut Map<String, Value>) {
    keep_structural(row);
    row.insert("title".into(), Value::String(String::new()));
    row.insert("preview".into(), Value::String(String::new()));
}

/// [`blank_row`] of a list row's JSON; a row that does not parse answers as an empty one.
pub(crate) fn blank_summary(summary: &str) -> String {
    let mut row = match serde_json::from_str::<Value>(summary) {
        Ok(Value::Object(row)) => row,
        _ => Map::new(),
    };
    blank_row(&mut row);
    Value::Object(row).to_string()
}

/// What became of the sensitive rewrites of this start's withheld sessions, for a caller that waits for one
/// ([`SqliteStore::rewrite_settled`]): a release is read from the catalog, a failure is kept here.
#[derive(Default)]
pub(super) struct Rewrites {
    failed: std::sync::Mutex<std::collections::HashMap<String, String>>,
    changed: tokio::sync::Notify,
    /// How many callers found their session still withheld and waited.
    waited: std::sync::atomic::AtomicUsize,
}

impl SqliteStore {
    /// The withheld sessions that hold a worker row: the index answers their rows without their content (no session id,
    /// no task, no result), which is no account of the worker. A listing of the workers waits for each
    /// ([`rewrite_settled`](Self::rewrite_settled)) instead of answering without it.
    pub async fn withheld_workers(&self) -> Result<Vec<String>, DbError> {
        self.shared
            .gate
            .manifest(|c| {
                let mut stmt =
                    c.prepare_cached("SELECT w.id FROM withheld_sessions w JOIN sessions s ON s.id = w.id WHERE s.worker IS NOT NULL ORDER BY w.id")?;
                Ok(stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    /// Resolves once `session` no longer waits for its sensitive rewrite: `Ok` when it was released (or never withheld),
    /// [`DbError::Recovery`] when its rewrite failed in this start, which leaves it withheld until the next. A session
    /// held is not a session failed: this is the wait.
    pub async fn rewrite_settled(&self, session: &str) -> Result<(), DbError> {
        let mut counted = false;
        loop {
            let changed = self.shared.rewrites.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let failed = self.shared.rewrites.failed.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(session).cloned();
            if let Some(reason) = failed {
                return Err(DbError::Recovery { session: session.to_owned(), reason });
            }
            if !self.is_withheld(session).await? {
                return Ok(());
            }
            if !std::mem::replace(&mut counted, true) {
                self.shared.rewrites.waited.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            changed.await;
        }
    }

    /// How many callers of [`rewrite_settled`](Self::rewrite_settled) waited so far.
    #[cfg(any(test, feature = "test-support"))]
    pub fn rewrite_waits(&self) -> usize {
        self.shared.rewrites.waited.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Exactly `sessions` owe a sensitive rewrite (the set a start computes; whatever an earlier start withheld goes): the
    /// index answers no content of them until each is released. Resolves once committed.
    ///
    /// Boot only, before anything is served: nothing adds to the set afterwards. The reads' safety rests on that (a
    /// session's release is never undone in a boot, so the log reads' copy, cleared after the release commits, never
    /// lets through what the catalog withholds; see `mixdog-core-session` `OwedRewrites`).
    ///
    /// It needs a working writer and no repaired row: it waits for no repair owed at open, and the repairs start once it
    /// is committed, so each reads this start's set and projects nothing of a session in it.
    pub async fn withhold(&self, sessions: Vec<String>) -> Result<(), DbError> {
        self.ask(|ack| super::Command::Withhold { sessions, ack }).await?;
        self.shared.gate.start_repairs();
        Ok(())
    }

    /// `session` is answered in full again; a subscribed roster is told its row changed from the one it was answered without
    /// content. Only once its rows were rebuilt from its rewritten log. A session whose repair was owed at open and left
    /// for its rewrite is repaired first, from the rewritten log.
    pub async fn release_withheld(&self, session: &str) -> Result<(), DbError> {
        // Held to queued in one step: no read is admitted between. The releaser waits for the outcome of the repair it
        // queued; one that fails settles the session as failed, and this is its error.
        if self.shared.gate.release(session) {
            self.shared.gate.settled(super::Need::of(&[session])).await?;
        }
        let id = session.to_owned();
        let released = self.ask(|ack| super::Command::Release { session: id, ack }).await;
        self.shared.rewrites.changed.notify_waiters();
        released
    }

    /// The rewrite `session` was held for failed in this start: its repair settles as failed (with the forks held for
    /// it), and every access that waited for it is woken with that. It is not tried again before the next start, whose
    /// open finds what the session is owed. `false` when the session was not held.
    pub fn fail_withheld(&self, session: &str, reason: &str) -> bool {
        let why = format!("{session}: its sensitive rewrite failed ({reason})");
        // Kept for a session that was level with its log too: it owes no repair, and stays withheld all the same.
        self.shared.rewrites.failed.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(session.to_owned(), why.clone());
        self.shared.rewrites.changed.notify_waiters();
        self.shared.gate.fail_held(session, why)
    }

    /// Whether `session` still owes its sensitive rewrite, read now in the caller's lane job. The withheld set is no
    /// projection of a log: it is read as it stands.
    pub fn withheld_on_lane<L>(&self, _lane: &InLane<L>, session: &str) -> Result<bool, DbError> {
        self.shared.gate.manifest_here(|c| Ok(is_withheld_in(c, session)?))
    }

    /// Whether `session` still owes its sensitive rewrite.
    pub async fn is_withheld(&self, session: &str) -> Result<bool, DbError> {
        let session = session.to_owned();
        self.shared.gate.manifest(move |c| Ok(is_withheld_in(c, &session)?)).await
    }

    /// Every session still owing its sensitive rewrite.
    pub async fn withheld_sessions(&self) -> Result<Vec<String>, DbError> {
        self.shared.gate.manifest(|c| Ok(withheld_in(c)?.into_iter().collect())).await
    }
}

/// The writer's side: `Command::Withhold` and `Command::Release`.
impl super::Writer {
    pub(super) fn withhold_on(tx: &rusqlite::Transaction<'_>, sessions: &[String]) -> rusqlite::Result<()> {
        tx.execute("DELETE FROM withheld_sessions", [])?;
        let mut insert = tx.prepare_cached("INSERT OR IGNORE INTO withheld_sessions (id) VALUES (?1)")?;
        for session in sessions {
            insert.execute([session])?;
        }
        Ok(())
    }

    /// Clears `session`'s withheld state in `tx`; with `watch`, the row change a roster that showed it blank is told (its
    /// row as `tx` holds it, from the blank one). The row's worker revision moves, so a worker-index load since then reads it
    /// again. Nothing when it was not withheld.
    pub(super) fn release_on(tx: &rusqlite::Transaction<'_>, session: &str, watch: bool) -> rusqlite::Result<Option<super::RowEdge>> {
        if tx.prepare_cached("DELETE FROM withheld_sessions WHERE id = ?1")?.execute([session])? == 0 {
            return Ok(None);
        }
        let row = tx
            .prepare_cached("SELECT summary, archived, deleted, user_name FROM sessions WHERE id = ?1")?
            .query_row([session], |r| Ok(super::StoredRow { summary: r.get(0)?, archived: r.get(1)?, deleted: r.get(2)?, user_name: r.get(3)? }))
            .optional()?;
        let Some(after) = row else { return Ok(None) };
        tx.prepare_cached("UPDATE worker_revision SET rev = rev + 1")?.execute([])?;
        tx.prepare_cached("UPDATE sessions SET worker_rev = (SELECT rev FROM worker_revision) WHERE id = ?1")?.execute([session])?;
        Ok(watch.then(|| {
            let before = super::StoredRow { summary: blank_summary(&after.summary), user_name: None, ..after.clone() };
            super::RowEdge { id: session.to_owned(), before: Some(before), after }
        }))
    }
}
