//! The one listing of every stored session's list row, for the readers that need more than
//! `thread/list`'s lead-visible rows: the idle sweep (Node `sweep-plan.mjs` `collectSweepRows`
//! feeding `sweep-row.mjs`, which decide from `owner`, `status`, `updatedAt`, `lastHeartbeatAt`,
//! `createdAt` and the conversation count) and the heartbeat's session catalog (Node
//! `listSessionCatalog`: every session but the agent-only ones, with `sourceName`, `owner`,
//! `visibility`).
//!
//! Node reads the sweep's fields from the session file and falls back to the summary row
//! (`effectiveFields`). The catalog's list row is built from that same header
//! (`summary::catalog_row`, `_sessionSummary`), so one query over `sessions` answers both and no
//! session file is read again. Only the sweep also `stat`s each session's newest log file, for the
//! record's mtime.

use std::io::ErrorKind;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use rusqlite::Connection;
use rusqlite::params;
use serde_json::Map;
use serde_json::Value;

use super::DbError;
use super::SqliteStore;
use super::lead::CatalogCursor;
use crate::summary::get;

/// Not deleted sessions with their first log file in place, in catalog order (newest activity
/// first, ties by id) after the keyset position. `?1`: agent-only sessions included; `?2`/`?3`:
/// the position; `?4`: the row cap (-1: none).
const LIST_SQL: &str = "SELECT summary, newest_file_no FROM sessions
     WHERE deleted = 0 AND log_id <> '' AND (?1 OR visibility IS NOT 'agent-only')
       AND (?2 IS NULL OR activity < ?2 OR (activity = ?2 AND id > ?3))
     ORDER BY activity DESC, id ASC LIMIT ?4";

/// One listed session: its list row and the number of its newest log file.
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
    pub row: Map<String, Value>,
    pub newest_file_no: u32,
}

fn list_on(c: &Connection, agent_only: bool, after: Option<&CatalogCursor>, limit: Option<usize>) -> Result<Vec<Listed>, DbError> {
    let mut stmt = c.prepare_cached(LIST_SQL)?;
    let found: Vec<(String, u32)> = stmt
        .query_map(
            params![
                agent_only,
                after.map(|a| a.activity),
                after.map(|a| a.id.clone()),
                limit.map_or(-1, |n| i64::try_from(n).unwrap_or(i64::MAX))
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?
        .collect::<Result<_, _>>()?;
    found
        .into_iter()
        .map(|(summary, newest_file_no)| match serde_json::from_str::<Value>(&summary) {
            Ok(Value::Object(row)) => Ok(Listed { row, newest_file_no }),
            _ => Err(DbError::Sqlite(rusqlite::Error::InvalidColumnType(0, "summary".into(), rusqlite::types::Type::Text))),
        })
        .collect()
}

/// The session record's file stamp (`sessionRecordStampOfSync`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordStamp {
    /// The newest log file's modification time, epoch ms.
    At(i64),
    /// The file is gone: the record is not there to sweep.
    Absent,
    /// The `stat` failed for another reason: the file is very likely still there, so the sweep
    /// leaves the session exactly as it is.
    Unreadable(String),
}

/// One session as the idle sweep reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct SweepSession {
    pub id: String,
    /// The record's `owner` when it is a non-empty string, else the list row's (`'user'` for a
    /// record without one); empty when it is not a string (`typeof owner === 'string'`).
    pub owner: String,
    pub status: String,
    pub closed: bool,
    pub updated_at: i64,
    pub last_heartbeat_at: i64,
    pub created_at: i64,
    /// `subAgentActivityAt(header)`: the baseline the runtime's delete admission compares against.
    pub activity: i64,
    /// The list row's `messageCount`.
    pub message_count: u64,
    pub record: RecordStamp,
}

/// `Number(value) > 0 ? Number(value) : 0` over a list row's number.
fn positive(row: &Map<String, Value>, key: &str) -> f64 {
    get(row, key).and_then(Value::as_f64).filter(|n| *n > 0.0).unwrap_or(0.0)
}

fn sweep_session(listed: &Listed, record: RecordStamp) -> SweepSession {
    let row = &listed.row;
    let (last_used, updated, created, heartbeat) =
        (positive(row, "lastUsedAt"), positive(row, "updatedAt"), positive(row, "createdAt"), positive(row, "lastHeartbeatAt"));
    // `subAgentActivityAt`: the first positive of lastUsedAt, updatedAt, createdAt; the heartbeat if later.
    let turn = [last_used, updated, created].into_iter().find(|n| *n > 0.0).unwrap_or(0.0);
    let text = |key: &str| get(row, key).and_then(Value::as_str).unwrap_or_default().to_owned();
    SweepSession {
        id: text("id"),
        owner: text("owner"),
        status: text("status"),
        closed: get(row, "closed") == Some(&Value::Bool(true)),
        updated_at: updated as i64,
        last_heartbeat_at: heartbeat as i64,
        created_at: created as i64,
        activity: turn.max(heartbeat) as i64,
        message_count: get(row, "messageCount").and_then(Value::as_u64).unwrap_or(0),
        record,
    }
}

impl SqliteStore {
    /// `limit` list rows after `after` (all when `None`), in catalog order; agent-only sessions
    /// only when `agent_only`.
    pub async fn list_sessions(&self, agent_only: bool, after: Option<CatalogCursor>, limit: Option<usize>) -> Result<Vec<Listed>, DbError> {
        self.read(move |c| list_on(c, agent_only, after.as_ref(), limit)).await
    }

    /// Every session the idle sweep visits (agent-only ones too): the one listing, then one
    /// `stat` of each session's newest log file under `sessions` (`<data>/sessions`).
    pub async fn sweep_sessions(&self, sessions: PathBuf) -> Result<Vec<SweepSession>, DbError> {
        self.reconciled().await?;
        self.shared
            .pool
            .run_in_lane(move |lane, c| {
                Ok(list_on(c, true, None, None)?
                    .iter()
                    .map(|listed| {
                        let id = get(&listed.row, "id").and_then(Value::as_str).unwrap_or_default();
                        let path = sessions.join(id).join(crate::log::log_name(listed.newest_file_no));
                        let record = match mixdog_statefile::metadata(lane, &path) {
                            Ok(meta) => match meta.modified() {
                                Ok(at) => RecordStamp::At(at.duration_since(UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))),
                                Err(e) => RecordStamp::Unreadable(e.to_string()),
                            },
                            Err(e) if e.kind() == ErrorKind::NotFound => RecordStamp::Absent,
                            Err(e) => RecordStamp::Unreadable(format!("{}: {e}", path.display())),
                        };
                        sweep_session(listed, record)
                    })
                    .collect())
            })
            .await
    }
}