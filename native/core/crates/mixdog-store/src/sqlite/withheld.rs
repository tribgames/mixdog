//! The sessions whose catalog rows were projected from a log that still holds a value marked sensitive since: their log
//! rewrite runs behind the serving core (`mixdog-core-session` `StoreThreads::owe_marks`). Whether a session is withheld is
//! the catalog's own state (`withheld_sessions`), not a copy in memory: it is set once at boot, cleared for a session only by
//! a release committed after the session's rows were rebuilt from its rewritten log, and every read that can answer a
//! session's content decides from it in the read transaction of the rows it answers. So a read sees the old rows withheld,
//! the new rows withheld, or the new rows released, never the old rows released. Withheld, a session's index reads answer only what is no content of it (ids, times, counts, states,
//! places, flags): no title, preview, worker text or listed header member, and no search finds it. Its log reads refuse it
//! ([`SqliteStore::withheld_on_lane`]).

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
    "id", "updatedAt", "lastUsedAt", "createdAt", "lastHeartbeatAt", "closed", "status", "owner", "agent", "sessionMode",
    "sourceType", "sourceName", "scopeKey", "parentSessionId", "ownerSessionId", "visibility", "clientHostPid", "hostPid",
    "cwd", "desktopSession", "workspace", "roomMembers", "provider", "model", "presetName", "effort", "fast", "autoEffort",
    "modelParameters", "agentTag", "tag", "task_id", "taskId", "permission", "permissionMode", "toolPermission",
    "schemaAllowedTools", "taskType", "messageCount", "compactCount", "realTurnCount", "generation", "storageMtimeMs",
    "storageSize", "detachedReason", "importKey", "inheritedFromSessionId", "favoriteAt", "retiredAt", "readState",
    "archivedAt", "state", "stage", "startedAt", "finishedAt", "cancelledAt", "turnStartedAt",
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

impl SqliteStore {
    /// Exactly `sessions` owe a sensitive rewrite (the set a start computes; whatever an earlier start withheld goes): the
    /// index answers no content of them until each is released. Resolves once committed.
    ///
    /// Boot only, before anything is served: nothing adds to the set afterwards. The reads' safety rests on that (a
    /// session's release is never undone in a boot, so the log reads' copy, cleared after the release commits, never
    /// lets through what the catalog withholds; see `mixdog-core-session` `OwedRewrites`).
    pub async fn withhold(&self, sessions: Vec<String>) -> Result<(), DbError> {
        self.ask(|ack| super::Command::Withhold { sessions, ack }).await
    }

    /// `session` is answered in full again; a subscribed roster is told its row changed from the one it was answered without
    /// content. Only once its rows were rebuilt from its rewritten log.
    pub async fn release_withheld(&self, session: &str) -> Result<(), DbError> {
        let session = session.to_owned();
        self.ask(|ack| super::Command::Release { session, ack }).await
    }

    /// Whether `session` still owes its sensitive rewrite, read now in the caller's lane job.
    pub fn withheld_on_lane<L>(&self, _lane: &InLane<L>, session: &str) -> Result<bool, DbError> {
        self.shared.gate.with(|c| Ok(is_withheld_in(c, session)?))
    }

    /// Whether `session` still owes its sensitive rewrite.
    pub async fn is_withheld(&self, session: &str) -> Result<bool, DbError> {
        let session = session.to_owned();
        self.read(move |c| Ok(is_withheld_in(c, &session)?)).await
    }

    /// Every session still owing its sensitive rewrite.
    pub async fn withheld_sessions(&self) -> Result<Vec<String>, DbError> {
        self.read(|c| Ok(withheld_in(c)?.into_iter().collect())).await
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
