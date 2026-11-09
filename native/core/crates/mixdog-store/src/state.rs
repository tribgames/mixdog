//! `state/core.sqlite` (FORMAT.md §8.3, SPEC R30): the one handle on the core's small
//! non-derived state. One writer thread runs each domain owner's write as its own
//! `BEGIN IMMEDIATE` transaction, so a domain change and its `ops` row commit together;
//! reads use a small connection pool. Every write a caller submits is its own bounded
//! unit (retention deletes take a row limit).
#![allow(clippy::disallowed_types, reason = "mixdog-store is the sanctioned home of rusqlite")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc;

use mixdog_rt::InteractiveIo;
use mixdog_rt::SqliteWriterThread;
use mixdog_rt::ThreadToken;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::params;
use tokio::sync::oneshot;

use crate::schema::sql::STATE_APPLICATION_ID;
use crate::schema::sql::STATE_DDL;
use crate::schema::sql::STATE_USER_VERSION;
use crate::sqlite::DbError;
use crate::sqlite::ReadPool;
use crate::sqlite::open_schema;

/// `ops.state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpRowState {
    InProgress,
    Applied,
    Rejected,
    Fenced,
    ExternalPending,
    ExternalUnknown,
}

impl OpRowState {
    pub fn as_str(self) -> &'static str {
        match self {
            OpRowState::InProgress => "inProgress",
            OpRowState::Applied => "applied",
            OpRowState::Rejected => "rejected",
            OpRowState::Fenced => "fenced",
            OpRowState::ExternalPending => "externalPending",
            OpRowState::ExternalUnknown => "externalUnknown",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        [
            OpRowState::InProgress,
            OpRowState::Applied,
            OpRowState::Rejected,
            OpRowState::Fenced,
            OpRowState::ExternalPending,
            OpRowState::ExternalUnknown,
        ]
        .into_iter()
        .find(|v| v.as_str() == s)
    }
}

/// One `ops` row. `outcome` is the owner's JSON text (result, error, external effect).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpRow {
    pub method: String,
    pub payload_digest: String,
    pub state: OpRowState,
    pub outcome: Option<String>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

/// UUIDv7 time order (P §9.5): the lowest v7 id of millisecond `ms`. Lowercase ids of
/// earlier milliseconds sort below it, ids of `ms` and later at or above it.
pub fn v7_floor(ms: u64) -> String {
    format!("{:08x}-{:04x}-7000-8000-000000000000", ms >> 16, ms & 0xffff)
}

/// The millisecond of a UUIDv7 text id.
pub fn v7_ms(id: &str) -> Option<u64> {
    let (hi, lo) = (id.get(..8)?, id.get(9..13)?);
    if id.as_bytes().get(8) != Some(&b'-') {
        return None;
    }
    Some((u64::from_str_radix(hi, 16).ok()? << 16) | u64::from_str_radix(lo, 16).ok()?)
}

/// A `projects` row (DS §4.1 desktop project preferences).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRow {
    pub path: String,
    pub alias: Option<String>,
    pub hidden: bool,
    /// Order among hidden projects.
    pub hidden_rank: Option<i64>,
    pub last_used_at: Option<i64>,
    /// The registry name, apart from the alias; `None` is not recorded (listed under the alias, else the folder).
    pub name: Option<String>,
}

/// The transaction a domain owner writes in: typed writes of its domain rows and of its
/// op (`put_op`), all committed together. The store owns every statement.
pub struct StateTx<'a> {
    tx: &'a Transaction<'a>,
}

impl StateTx<'_> {
    pub fn put_project(&self, row: &ProjectRow) -> Result<(), DbError> {
        self.tx
            .prepare_cached(
                "INSERT INTO projects (path, alias, hidden, hidden_rank, last_used_at, name) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(path) DO UPDATE SET alias = excluded.alias, hidden = excluded.hidden,
                   hidden_rank = excluded.hidden_rank, last_used_at = excluded.last_used_at, name = excluded.name",
            )?
            .execute(params![row.path, row.alias, row.hidden, row.hidden_rank, row.last_used_at, row.name])?;
        Ok(())
    }

    pub fn delete_project(&self, path: &str) -> Result<bool, DbError> {
        Ok(self.tx.prepare_cached("DELETE FROM projects WHERE path = ?1")?.execute([path])? > 0)
    }

    /// Writes the room document (JSON text).
    pub fn put_room(&self, room_id: &str, doc: &str) -> Result<(), DbError> {
        self.tx
            .prepare_cached(
                "INSERT INTO rooms (room_id, doc) VALUES (?1, ?2) ON CONFLICT(room_id) DO UPDATE SET doc = excluded.doc",
            )?
            .execute([room_id, doc])?;
        Ok(())
    }

    pub fn delete_room(&self, room_id: &str) -> Result<bool, DbError> {
        Ok(self.tx.prepare_cached("DELETE FROM rooms WHERE room_id = ?1")?.execute([room_id])? > 0)
    }

    /// `meta` key/value (`job:<id>` cursors, `migration:<item key>`).
    pub fn put_meta(&self, key: &str, value: &str) -> Result<(), DbError> {
        self.tx
            .prepare_cached(
                "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )?
            .execute([key, value])?;
        Ok(())
    }

    pub fn delete_meta(&self, key: &str) -> Result<bool, DbError> {
        Ok(self.tx.prepare_cached("DELETE FROM meta WHERE key = ?1")?.execute([key])? > 0)
    }

    /// A `meta` value read inside this transaction, so a read-modify-write is one unit.
    pub fn meta(&self, key: &str) -> Result<Option<String>, DbError> {
        Ok(self.tx.prepare_cached("SELECT value FROM meta WHERE key = ?1")?.query_row([key], |r| r.get(0)).optional()?)
    }

    /// Every `meta` entry whose key starts with `prefix`, by key.
    pub fn meta_prefix(&self, prefix: &str) -> Result<Vec<(String, String)>, DbError> {
        meta_prefix_rows(self.tx, prefix)
    }

    /// Deletes every `meta` entry whose key starts with `prefix`; returns how many.
    pub fn delete_meta_prefix(&self, prefix: &str) -> Result<usize, DbError> {
        Ok(self
            .tx
            .prepare_cached("DELETE FROM meta WHERE key >= ?1 AND key < ?2")?
            .execute([prefix, &prefix_end(prefix)])?)
    }

    /// Writes `row` for `(scope, op_id)`, replacing any record of it.
    pub fn put_op(&self, scope: &str, op_id: &str, row: &OpRow) -> Result<(), DbError> {
        self.tx
            .prepare_cached(
                "INSERT INTO ops (scope, op_id, method, payload_digest, state, outcome, created_at, completed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(scope, op_id) DO UPDATE SET method = excluded.method,
                   payload_digest = excluded.payload_digest, state = excluded.state,
                   outcome = excluded.outcome, created_at = excluded.created_at,
                   completed_at = excluded.completed_at",
            )?
            .execute(params![
                scope,
                op_id,
                row.method,
                row.payload_digest,
                row.state.as_str(),
                row.outcome,
                row.created_at,
                row.completed_at
            ])?;
        Ok(())
    }

    /// Persists the scope's retention watermark (as `v7_floor(ms)`).
    pub fn set_watermark(&self, scope: &str, ms: u64) -> Result<(), DbError> {
        self.tx
            .prepare_cached(
                "INSERT INTO op_watermarks (scope, watermark) VALUES (?1, ?2)
                 ON CONFLICT(scope) DO UPDATE SET watermark = excluded.watermark",
            )?
            .execute(params![scope, v7_floor(ms)])?;
        Ok(())
    }

    /// Deletes up to `limit` of the scope's oldest ops whose time is below `ms`.
    pub fn delete_ops_before(&self, scope: &str, ms: u64, limit: usize) -> Result<usize, DbError> {
        Ok(self
            .tx
            .prepare_cached(
                "DELETE FROM ops WHERE scope = ?1 AND op_id IN (SELECT op_id FROM ops
                 WHERE scope = ?1 AND op_id < ?2 ORDER BY op_id LIMIT ?3)",
            )?
            .execute(params![scope, v7_floor(ms), limit as i64])?)
    }
}

/// The first key above every key that starts with `prefix` (keys compare bytewise, and no
/// scalar value exceeds U+10FFFF).
fn prefix_end(prefix: &str) -> String {
    format!("{prefix}\u{10FFFF}")
}

fn meta_prefix_rows(conn: &Connection, prefix: &str) -> Result<Vec<(String, String)>, DbError> {
    let mut stmt = conn.prepare_cached("SELECT key, value FROM meta WHERE key >= ?1 AND key < ?2 ORDER BY key")?;
    let rows = stmt.query_map([prefix, &prefix_end(prefix)], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    Ok(rows)
}

type Job = Box<dyn FnOnce(&mut Connection) + Send>;

struct Shared {
    path: PathBuf,
    pool: Arc<ReadPool>,
}

/// Brings a `user_version` 1 file to 2 in one transaction. Any other file is left to `open_schema`'s checks.
pub(crate) fn upgrade_v1(path: &Path) -> Result<(), DbError> {
    if !path.exists() {
        return Ok(());
    }
    let mut conn = crate::sqlite::open_connection(path)?;
    let app: i32 = conn.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if app == STATE_APPLICATION_ID && version == 1 {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute_batch(crate::schema::sql::STATE_V2_DELTA)?;
        tx.commit()?;
    }
    Ok(())
}

const PROJECT_SELECT: &str = "SELECT path, alias, hidden, hidden_rank, last_used_at, name FROM projects";

fn project_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRow> {
    Ok(ProjectRow {
        name: r.get(5)?,
        path: r.get(0)?,
        alias: r.get(1)?,
        hidden: r.get(2)?,
        hidden_rank: r.get(3)?,
        last_used_at: r.get(4)?,
    })
}

/// Cloneable handle on `state/core.sqlite`; the writer thread exits with the last handle.
#[derive(Clone)]
pub struct CoreState {
    shared: Arc<Shared>,
    sender: mpsc::Sender<Job>,
}

impl std::fmt::Debug for CoreState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreState").field("path", &self.shared.path).finish()
    }
}

impl CoreState {
    /// Opens (creating if empty) the database. Boot recovery (P §9.6) runs here, before
    /// any op can start: every `inProgress` op becomes `externalUnknown`; returns how many.
    /// Reads run as jobs on `read_lane`.
    pub fn open(thread: SqliteWriterThread, read_lane: InteractiveIo, path: &Path) -> Result<(CoreState, usize), DbError> {
        upgrade_v1(path)?;
        let mut conn = open_schema(path, STATE_DDL, STATE_APPLICATION_ID, STATE_USER_VERSION)?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let recovered = tx.execute("UPDATE ops SET state = 'externalUnknown' WHERE state = 'inProgress'", [])?;
        tx.commit()?;
        let (sender, rx) = mpsc::channel::<Job>();
        thread
            .spawn_thread("mixdog-state-writer", move |_| {
                while let Ok(job) = rx.recv() {
                    job(&mut conn);
                }
            })
            .map_err(|e| DbError::Write(e.to_string()))?;
        let state = CoreState {
            shared: Arc::new(Shared {
                path: path.to_path_buf(),
                pool: ReadPool::new(path, read_lane),
            }),
            sender,
        };
        Ok((state, recovered))
    }

    /// Runs `f` in one `BEGIN IMMEDIATE` transaction on the writer; commits when it
    /// returns `Ok`, rolls back otherwise.
    pub async fn write<R, F>(&self, f: F) -> Result<R, DbError>
    where
        F: FnOnce(&StateTx<'_>) -> Result<R, DbError> + Send + 'static,
        R: Send + 'static,
    {
        let (ack, rx) = oneshot::channel();
        let job: Job = Box::new(move |conn| {
            let result = (|| {
                let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                let out = f(&StateTx { tx: &tx })?;
                tx.commit()?;
                Ok(out)
            })();
            let _ = ack.send(result);
        });
        self.sender.send(job).map_err(|_| DbError::Stopped)?;
        rx.await.map_err(|_| DbError::Stopped)?
    }

    fn read<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, DbError>> + Send + 'static {
        self.shared.pool.run(f)
    }

    pub async fn project(&self, path: &str) -> Result<Option<ProjectRow>, DbError> {
        let path = path.to_owned();
        self.read(move |c| {
            Ok(c.prepare_cached(&format!("{PROJECT_SELECT} WHERE path = ?1"))?
                .query_row([&path], project_row)
                .optional()?)
        })
        .await
    }

    /// Every project preference row, by path.
    pub async fn projects(&self) -> Result<Vec<ProjectRow>, DbError> {
        self.read(|c| {
            let mut stmt = c.prepare_cached(&format!("{PROJECT_SELECT} ORDER BY path"))?;
            let rows = stmt.query_map([], project_row)?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .await
    }

    pub async fn room(&self, room_id: &str) -> Result<Option<String>, DbError> {
        let room_id = room_id.to_owned();
        self.read(move |c| {
            Ok(c.prepare_cached("SELECT doc FROM rooms WHERE room_id = ?1")?
                .query_row([&room_id], |r| r.get(0))
                .optional()?)
        })
        .await
    }

    /// Every room `(room_id, doc)`, by id.
    pub async fn rooms(&self) -> Result<Vec<(String, String)>, DbError> {
        self.read(|c| {
            let mut stmt = c.prepare_cached("SELECT room_id, doc FROM rooms ORDER BY room_id")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .await
    }

    pub async fn meta(&self, key: &str) -> Result<Option<String>, DbError> {
        let key = key.to_owned();
        self.read(move |c| {
            Ok(c.prepare_cached("SELECT value FROM meta WHERE key = ?1")?
                .query_row([&key], |r| r.get(0))
                .optional()?)
        })
        .await
    }

    /// Every `meta` entry whose key starts with `prefix`, by key.
    pub async fn meta_prefix(&self, prefix: &str) -> Result<Vec<(String, String)>, DbError> {
        let prefix = prefix.to_owned();
        self.read(move |c| meta_prefix_rows(c, &prefix)).await
    }

    /// The op record of `(scope, op_id)`.
    pub async fn op(&self, scope: &str, op_id: &str) -> Result<Option<OpRow>, DbError> {
        let (scope, op_id) = (scope.to_owned(), op_id.to_owned());
        self.read(move |c| {
            Ok(c.prepare_cached(
                "SELECT method, payload_digest, state, outcome, created_at, completed_at FROM ops
                 WHERE scope = ?1 AND op_id = ?2",
            )?
            .query_row([&scope, &op_id], |r| {
                let state: String = r.get(2)?;
                Ok(OpRow {
                    method: r.get(0)?,
                    payload_digest: r.get(1)?,
                    state: OpRowState::parse(&state).ok_or_else(|| {
                        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, state.into())
                    })?,
                    outcome: r.get(3)?,
                    created_at: r.get(4)?,
                    completed_at: r.get(5)?,
                })
            })
            .optional()?)
        })
        .await
    }

    /// The scope's persisted watermark (UUIDv7 milliseconds), if it ever pruned.
    pub async fn watermark(&self, scope: &str) -> Result<Option<u64>, DbError> {
        let scope = scope.to_owned();
        let text: Option<String> = self
            .read(move |c| {
                Ok(c.prepare_cached("SELECT watermark FROM op_watermarks WHERE scope = ?1")?
                    .query_row([&scope], |r| r.get(0))
                    .optional()?)
            })
            .await?;
        text.map(|t| v7_ms(&t).ok_or_else(|| DbError::Write(format!("watermark {t:?} is not a UUIDv7"))))
            .transpose()
    }

    /// The millisecond of the scope's `n`-th newest op (1-based); `None` below `n` ops.
    pub async fn nth_newest_ms(&self, scope: &str, n: usize) -> Result<Option<u64>, DbError> {
        if n == 0 {
            return Ok(None);
        }
        let scope = scope.to_owned();
        let id: Option<String> = self
            .read(move |c| {
                Ok(c.prepare_cached("SELECT op_id FROM ops WHERE scope = ?1 ORDER BY op_id DESC LIMIT 1 OFFSET ?2")?
                    .query_row(params![scope, (n - 1) as i64], |r| r.get(0))
                    .optional()?)
            })
            .await?;
        id.map(|t| v7_ms(&t).ok_or_else(|| DbError::Write(format!("op id {t:?} is not a UUIDv7"))))
            .transpose()
    }

    /// Durably reserves `count` values of counter `name` (meta key `seq:<name>`):
    /// `[start, start + count)`, starting at 1, increasing across restarts. Values of a
    /// reservation not handed out before a crash are skipped, never reused.
    pub async fn reserve_ids(&self, name: &str, count: u64) -> Result<std::ops::Range<u64>, DbError> {
        let key = format!("seq:{name}");
        self.write(move |tx| {
            let next: Option<String> = tx
                .tx
                .prepare_cached("SELECT value FROM meta WHERE key = ?1")?
                .query_row([&key], |r| r.get(0))
                .optional()?;
            let start = match next {
                Some(text) => text.parse::<u64>().map_err(|e| DbError::Write(format!("{key}: {e}")))?,
                None => 1,
            };
            let end = start.checked_add(count).ok_or_else(|| DbError::Write(format!("{key} exhausted")))?;
            tx.put_meta(&key, &end.to_string())?;
            Ok(start..end)
        })
        .await
    }

    /// `StateTx::set_watermark` in its own transaction.
    pub async fn set_watermark(&self, scope: &str, ms: u64) -> Result<(), DbError> {
        let scope = scope.to_owned();
        self.write(move |tx| tx.set_watermark(&scope, ms)).await
    }

    /// `StateTx::delete_ops_before` in its own transaction.
    pub async fn delete_ops_before(&self, scope: &str, ms: u64, limit: usize) -> Result<usize, DbError> {
        let scope = scope.to_owned();
        self.write(move |tx| tx.delete_ops_before(&scope, ms, limit)).await
    }
}

/// Monotonic, crash-safe ids (`ApprovalIds`, P §8.2): values come from blocks reserved
/// durably by `CoreState::reserve_ids`; the next block is reserved in the background once
/// half of the current one is used, so `next` normally completes at once. When both
/// blocks are used up it awaits that reservation, and returns its error if
/// `state/core.sqlite` fails (the next call reserves again).
pub struct IdAllocator {
    state: CoreState,
    name: Arc<str>,
    block: u64,
    shared: Arc<AllocShared>,
}

struct AllocShared {
    blocks: std::sync::Mutex<Blocks>,
    refilled: tokio::sync::Notify,
}

struct Blocks {
    current: std::ops::Range<u64>,
    next: Option<std::ops::Range<u64>>,
    refilling: bool,
    failed: Option<DbError>,
}

impl IdAllocator {
    /// Reserves the first block.
    pub async fn new(state: CoreState, name: &str, block: u64) -> Result<IdAllocator, DbError> {
        let current = state.reserve_ids(name, block).await?;
        Ok(IdAllocator {
            state,
            name: name.into(),
            block,
            shared: Arc::new(AllocShared {
                blocks: std::sync::Mutex::new(Blocks { current, next: None, refilling: false, failed: None }),
                refilled: tokio::sync::Notify::new(),
            }),
        })
    }

    pub async fn next(&self) -> Result<u64, DbError> {
        loop {
            let refilled = self.shared.refilled.notified();
            tokio::pin!(refilled);
            {
                let mut b = self.shared.blocks.lock().expect("allocator lock");
                if let Some(id) = b.current.next() {
                    if b.next.is_none() && !b.refilling && b.current.end - b.current.start <= self.block / 2 {
                        self.refill(&mut b);
                    }
                    return Ok(id);
                }
                if let Some(block) = b.next.take() {
                    b.current = block;
                    continue;
                }
                if let Some(e) = b.failed.take() {
                    return Err(e);
                }
                if !b.refilling {
                    self.refill(&mut b);
                }
                // Registered before the lock is released, so the refill's wake is not lost.
                refilled.as_mut().enable();
            }
            refilled.await;
        }
    }

    fn refill(&self, b: &mut Blocks) {
        b.refilling = true;
        let (state, name, block, shared) = (self.state.clone(), self.name.clone(), self.block, self.shared.clone());
        tokio::spawn(async move {
            let reserved = state.reserve_ids(&name, block).await;
            {
                let mut b = shared.blocks.lock().expect("allocator lock");
                b.refilling = false;
                match reserved {
                    Ok(range) => b.next = Some(range),
                    Err(e) => b.failed = Some(e),
                }
            }
            shared.refilled.notify_waiters();
        });
    }
}

#[cfg(test)]
mod tests {
    use mixdog_rt::testing::tokens;

    use super::*;

    fn id(ms: u64, n: u16) -> String {
        format!("{:08x}-{:04x}-7{:03x}-8000-000000000000", ms >> 16, ms & 0xffff, n)
    }

    fn row(state: OpRowState) -> OpRow {
        OpRow {
            method: "rooms/update".into(),
            payload_digest: "sha256:00".into(),
            state,
            outcome: None,
            created_at: 1,
            completed_at: None,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ops_commit_with_the_domain_change_and_prune_in_batches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let (state, recovered) = CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, &path).unwrap();
        assert_eq!(recovered, 0);
        // Domain change and op row in one transaction; a failing owner commits neither.
        state
            .write(|tx| {
                tx.put_room("r1", "{}")?;
                tx.put_op("rooms", &id(1000, 1), &row(OpRowState::Applied))
            })
            .await
            .unwrap();
        let failed = state
            .write(|tx| {
                tx.put_room("r2", "{}")?;
                tx.put_op("rooms", &id(1001, 1), &row(OpRowState::Applied))?;
                Err::<(), _>(DbError::Write("owner refused".into()))
            })
            .await;
        assert!(failed.is_err());
        assert_eq!(state.op("rooms", &id(1001, 1)).await.unwrap(), None);
        assert_eq!(state.op("rooms", &id(1000, 1)).await.unwrap(), Some(row(OpRowState::Applied)));
        assert_eq!(state.room("r1").await.unwrap().as_deref(), Some("{}"));
        assert_eq!(state.room("r2").await.unwrap(), None);

        for ms in 2000..2010 {
            state.write(move |tx| tx.put_op("rooms", &id(ms, 0), &row(OpRowState::Applied))).await.unwrap();
        }
        state.write(|tx| tx.put_op("rooms", &id(3000, 0), &row(OpRowState::InProgress))).await.unwrap();
        assert_eq!(state.nth_newest_ms("rooms", 1).await.unwrap(), Some(3000));
        assert_eq!(state.nth_newest_ms("rooms", 3).await.unwrap(), Some(2008));
        assert_eq!(state.nth_newest_ms("rooms", 50).await.unwrap(), None);
        assert_eq!(state.watermark("rooms").await.unwrap(), None);
        state.set_watermark("rooms", 2005).await.unwrap();
        assert_eq!(state.watermark("rooms").await.unwrap(), Some(2005));
        // 1000 and 2000..2004 are below 2005: two bounded batches.
        assert_eq!(state.delete_ops_before("rooms", 2005, 4).await.unwrap(), 4);
        assert_eq!(state.delete_ops_before("rooms", 2005, 4).await.unwrap(), 2);
        assert_eq!(state.delete_ops_before("rooms", 2005, 4).await.unwrap(), 0);
        assert!(state.op("rooms", &id(2005, 0)).await.unwrap().is_some());
        drop(state);

        let (state, recovered) = CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, &path).unwrap();
        assert_eq!(recovered, 1);
        assert_eq!(state.op("rooms", &id(3000, 0)).await.unwrap().unwrap().state, OpRowState::ExternalUnknown);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ids_increase_across_blocks_and_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let (state, _) = CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, &path).unwrap();
        // A block of 100: ten ids never start a background reservation, so nothing is in
        // flight when the store is reopened.
        let ids = IdAllocator::new(state.clone(), "approval", 100).await.unwrap();
        let mut first = Vec::new();
        for _ in 0..10 {
            first.push(ids.next().await.unwrap());
        }
        assert_eq!(first, (1..=10).collect::<Vec<_>>());
        drop(ids);
        drop(state);
        // A restart skips whatever was reserved and not handed out; it never repeats.
        let (state, _) = CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, &path).unwrap();
        let ids = IdAllocator::new(state, "approval", 4).await.unwrap();
        let after = ids.next().await.unwrap();
        assert!(after > 10, "{after}");
        assert!(ids.next().await.unwrap() > after);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_exhausted_allocator_returns_the_reservation_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let (state, _) = CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, &path).unwrap();
        let ids = IdAllocator::new(state.clone(), "approval", 2).await.unwrap();
        // The next reservation cannot succeed: the counter is no longer a number.
        state.write(|tx| tx.put_meta("seq:approval", "broken")).await.unwrap();
        assert_eq!(ids.next().await.unwrap(), 1);
        assert_eq!(ids.next().await.unwrap(), 2);
        assert!(ids.next().await.is_err());
        // Repaired, the next call reserves again.
        state.write(|tx| tx.put_meta("seq:approval", "10")).await.unwrap();
        assert_eq!(ids.next().await.unwrap(), 10);
    }

    #[test]
    fn v7_floor_orders_by_millisecond() {
        assert_eq!(v7_ms(&v7_floor(0x0190_f0a0_1c2d)), Some(0x0190_f0a0_1c2d));
        assert!(id(5, 0xfff) < v7_floor(6));
        assert!(v7_floor(6) <= id(6, 0));
    }
}
