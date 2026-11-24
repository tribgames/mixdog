//! `index/store.sqlite` (FORMAT.md §8.2) behind one `SqliteStore`: a single writer thread
//! doing bounded transactions (RL §8.2, SPEC R31) and a pool of read connections.
//!
//! The writer alternates strictly between one append transaction (≤ `APPEND_ROWS` rows
//! and ≤ `APPEND_BYTES` of input, catalog rows coalesced per session) and one
//! maintenance step (≤ `STEP_ROWS` rows). A projection larger than the bound, or a
//! rewind that supersedes many rows, is applied over several transactions; the
//! session's projection cursor commits with each part, so a crash resumes from it.
#![allow(clippy::disallowed_types, reason = "mixdog-store::sqlite is the sanctioned home of rusqlite")]

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Instant;

#[cfg(test)]
mod batch_tests;
mod gate;
pub mod lead;
pub mod listing;
#[cfg(test)]
mod model_tests;
#[cfg(test)]
mod purge_tests;
#[cfg(test)]
mod released_tests;
#[cfg(test)]
mod retire_tests;
pub mod rewind;
mod withheld;
use gate::Need;
pub use gate::ProjectionError;
pub use gate::RepairReport;
#[cfg(test)]
pub(crate) use withheld::WITHHELD_DDL;
#[cfg(test)]
mod withheld_tests;

use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use mixdog_rt::SqliteWriterThread;
use mixdog_rt::ThreadToken;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::params;
use tokio::sync::oneshot;
#[cfg(test)]
use tokio::sync::watch;

use crate::fold::LineageIndex;
use crate::fold::LookupError;
use crate::projection::FrameKind;
use crate::projection::ProjectedFrame;
use crate::projection::Projection;
use crate::schema::checkpoint::FramePos;
use crate::schema::record::ApprovalPhase;
use crate::schema::record::Form;
use crate::schema::record::ModelSwitchEntry;
use crate::schema::record::RunPhase;
use crate::schema::record::TurnEndForm;
use crate::schema::sql::INDEX_APPLICATION_ID;
use crate::schema::sql::INDEX_DDL;
use crate::schema::sql::INDEX_USER_VERSION;
use crate::schema::sql::session_id_key;
use crate::summary::CatalogHead;
use crate::title::PlaceholderLabels;
use crate::title::TitleKind;
use crate::title::session_display_title;
use crate::worker::TagSession;
use crate::worker::WorkerRow;
use crate::worker::WorkerScope;

/// What starts the repairs a store owes at open, besides the commit of the start's withheld set ([`SqliteStore::withhold`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepairStart {
    /// Only that commit: an opener that always commits one before anything is served (the core's boot), so no access
    /// that waits can start a repair that would project a session it withholds.
    WithheldSet,
    /// Also the first access that waits for a repair: an opener that may never commit one, whose waiter would else wait
    /// for ever.
    FirstWait,
}

/// SPEC R31 append transaction bounds.
pub const APPEND_ROWS: usize = 512;
pub const APPEND_BYTES: usize = 1 << 20;
/// SPEC R31 maintenance step bound.
pub const STEP_ROWS: usize = 500;
/// SPEC R31: `wal_checkpoint(PASSIVE)` once the WAL holds this many pages.
pub const WAL_CHECKPOINT_PAGES: i32 = 1000;
/// Added to the [`rebuild_key`] value of a session a rebuild projects first (one that may hold a worker row): the order sorts
/// it ahead of every other, and a later start reads it back from the value.
const REBUILD_FIRST: u64 = 1 << 52;
/// SM §11.8: one history page reads at most this many frame bytes.
pub const PAGE_MAX_BYTES: u64 = 4 << 20;
/// Session search: the empty query lists this many rows.
pub const RECENT_SESSION_ROWS: usize = 10;

const READ_POOL: usize = 4;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    /// Another `application_id`/`user_version`. `SqliteStore::open` rebuilds the index
    /// from the logs instead of returning it; `state/core.sqlite` (user data) returns it.
    #[error("database needs a rebuild: {0}")]
    Rebuild(String),
    /// The transaction carrying this request failed (the writer reports it to every
    /// waiter of that transaction).
    #[error("index write failed: {0}")]
    Write(String),
    #[error("index writer stopped")]
    Stopped,
    /// The repair of a session the request rests on failed in this start ([`ProjectionError::Failed`]): the index has no
    /// answer, which is not to say the data is not there. It is not tried again before the next start.
    #[error("index recovery failed for {session}: {reason}")]
    Recovery { session: String, reason: String },
    /// The read lane's queue is full; the caller retries or reports busy.
    /// A lane refused the job as overloaded (its queue at the far bound, or no healthy worker);
    /// below that bound the job waits for a thread.
    #[error("overloaded: lane")]
    LaneFull,
    /// A job waiting for room on a lane was cancelled before it was queued or ran.
    #[error("lane job cancelled before it ran")]
    LaneCancelled,
    /// The lane shut down before the job ran.
    #[error("lane shut down before the job ran")]
    LaneShutDown,
    /// The lane has no healthy worker to run the job.
    #[error("lane has no healthy worker to run the job")]
    LaneWedged,
    /// The job was queued but its result never arrived (it was dropped, or its thread could not start).
    #[error("lane job result lost")]
    LaneJobLost,
    /// The history changed (a rewind) since the cursor was issued.
    #[error("history cursor is stale")]
    CursorStale,
}

/// Why a waiting submission ([`LaneToken::submit_wait`]) did not queue its job.
fn lane_unrun(error: mixdog_rt::SubmitWaitError) -> DbError {
    match error {
        mixdog_rt::SubmitWaitError::Full(_) => DbError::LaneFull,
        mixdog_rt::SubmitWaitError::Wedged(_) => DbError::LaneWedged,
        mixdog_rt::SubmitWaitError::Cancelled => DbError::LaneCancelled,
        mixdog_rt::SubmitWaitError::ShutDown(_) => DbError::LaneShutDown,
    }
}

/// Why an admitted lane job gave no result.
fn lane_lost(dropped: mixdog_rt::JobDropped) -> DbError {
    match dropped {
        mixdog_rt::JobDropped::Cancelled => DbError::LaneCancelled,
        mixdog_rt::JobDropped::ShutDown => DbError::LaneShutDown,
        mixdog_rt::JobDropped::Wedged => DbError::LaneWedged,
        mixdog_rt::JobDropped::NotStarted | mixdog_rt::JobDropped::Dropped => DbError::LaneJobLost,
    }
}

/// One read snapshot for a read of several statements: `None` when `c` already reads in one (a gated read's), else a
/// transaction of its own.
pub(crate) fn read_snapshot(c: &Connection) -> rusqlite::Result<Option<Transaction<'_>>> {
    if c.is_autocommit() { c.unchecked_transaction().map(Some) } else { Ok(None) }
}

pub(crate) fn open_connection(path: &Path) -> Result<Connection, DbError> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", crate::fsio::sqlite_synchronous())?;
    conn.pragma_update(None, "wal_autocheckpoint", 0)?;
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    // Page reads come from the OS page cache by mapping, not by a read call and a copy into the connection's 2 MB cache:
    // a scan of the index costs no private memory and no I/O syscalls (the mapping is shared with the page cache).
    conn.pragma_update(None, "mmap_size", MMAP_BYTES)?;
    conn.busy_timeout(std::time::Duration::ZERO)?;
    Ok(conn)
}

/// How much of a database file a connection maps ([`open_connection`]).
pub(crate) const MMAP_BYTES: i64 = 256 * 1024 * 1024;

/// Opens the writer connection, running the DDL on an empty file and checking the ids.
pub(crate) fn open_schema(path: &Path, ddl: &str, app_id: i32, user_version: i32) -> Result<Connection, DbError> {
    let conn = open_connection(path)?;
    let tables: i64 = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))?;
    if tables == 0 {
        conn.execute_batch(ddl)?;
    }
    check_schema(conn, app_id, user_version)
}

fn check_schema(mut conn: Connection, app_id: i32, user_version: i32) -> Result<Connection, DbError> {
    let app: i32 = conn.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if app != app_id || version != user_version {
        return Err(DbError::Rebuild(format!("application_id {app:#x}, user_version {version}")));
    }
    conn.wal_hook(Some(|wal: &mut rusqlite::hooks::Wal, pages| {
        if pages >= WAL_CHECKPOINT_PAGES {
            // The commit frame is already in the WAL: a failed checkpoint must not turn a committed transaction into an error.
            let _ = wal.checkpoint_v2(rusqlite::wal::CheckpointMode::PASSIVE);
        }
        Ok(())
    }))?;
    Ok(conn)
}

/// How long one statement of the writer connection ([`open_writer`]) lets SQLite's busy handler wait for a lock: a foreign
/// connection's write lock, or the readers of older WAL frames ([`truncate_wal`]). No bound on the wait as a whole: an
/// append transaction that still meets the lock keeps what is queued and begins again ([`Writer::append_transaction`]).
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// `wal_checkpoint(TRUNCATE)`: every WAL frame into the database, then the WAL emptied. A reader's snapshot holds
/// the frames it may still read, so SQLite's busy handler waits for those readers (each read job is one bounded
/// query), up to [`LOCK_WAIT`].
fn truncate_wal(conn: &Connection) -> Result<(), String> {
    match conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())? {
        0 => Ok(()),
        _ => Err(format!("the index WAL stayed in use by readers for {} s; it is truncated at the next attempt", LOCK_WAIT.as_secs())),
    }
}

/// The writer overwrites what it deletes (`secure_delete`): a row a sensitive rewrite replaces leaves no readable page.
/// Measured on a turn's index writes (one transaction: session row, 8 message rows, the search row replaced), its cost
/// was within the run-to-run noise (median 0.163-0.175 ms per turn either way).
fn open_writer(path: &Path, ddl: Option<&str>) -> Result<Connection, DbError> {
    let conn = match ddl {
        Some(ddl) => open_schema(path, ddl, INDEX_APPLICATION_ID, INDEX_USER_VERSION)?,
        // An empty file at the published path is not a valid empty projection. Rebuild
        // it from the logs just like a missing file, rather than installing DDL here.
        None => {
            let conn = check_schema(open_connection(path)?, INDEX_APPLICATION_ID, INDEX_USER_VERSION)?;
            let has_sessions = conn.query_row("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sessions'", [], |_| Ok(())).optional()?.is_some();
            if !has_sessions {
                return Err(DbError::Rebuild("missing sessions table".to_owned()));
            }
            conn
        }
    };
    conn.pragma_update(None, "secure_delete", "ON").map_err(|e| DbError::Write(e.to_string()))?;
    // The index has one writer in this process, and the data dir one process: a lock this connection meets is a foreign
    // one (a tool's, a test's). It is waited for inside SQLite, where a failed transaction would lose what it held.
    conn.busy_timeout(LOCK_WAIT)?;
    // Every index a writer opens holds it, a projection's included, so a rebuilt index and a fresh projection have the
    // same tables.
    conn.execute_batch(withheld::WITHHELD_DDL)?;
    Ok(conn)
}

/// The DDL the runtime builds an index with: a fresh generation (odd, so never the migration's 0) on top of the
/// schema, because a reader may hold a revision of the index this one replaces (this process's registry across a
/// reopen, or another process); the migration's index is built before any reader and keeps the DDL's fixed 0.
fn runtime_ddl() -> String {
    format!("{INDEX_DDL}\nUPDATE worker_revision SET gen = (random() & 0x7fffffffffffffff) | 1;")
}

/// The index database of a data dir.
pub const INDEX_FILE: &str = "index/store.sqlite";

/// The index at `path` opened for an in-place upgrade; `None` when there is no file or it is not an index of `version`.
#[allow(clippy::disallowed_methods, reason = "runs on the maintenance lane job of the index open")]
fn open_at_version(path: &Path, version: i32) -> Result<Option<Connection>, DbError> {
    if !path.exists() {
        return Ok(None);
    }
    let conn = open_connection(path)?;
    let app: i32 = conn.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let found: i32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    Ok((app == INDEX_APPLICATION_ID && found == version).then_some(conn))
}

/// The `modelParameters` member a version 19 `sessions.listed` takes, from the row's `summary` (which normalises the
/// header's member: an object as it is, an array as an object keyed by index, anything else and absence as null): the
/// header's object when only an object gives that summary, `None` when the summary does not tell which member the header
/// held (null: absent, null or a scalar; an object keyed `0..n`: an object or an array). An empty object is taken as the
/// header's: only an empty array also gives it, which the routes that write the member never do (they write objects), and
/// either says the session has no parameters; repairing the rows that hold it was most rows of a long-used index.
fn listed_model_parameters(summary: &serde_json::Value) -> Option<serde_json::Value> {
    let Some(serde_json::Value::Object(parameters)) = summary.get("modelParameters") else { return None };
    let from_array = !parameters.is_empty() && (0..parameters.len()).all(|i| parameters.contains_key(&i.to_string()));
    (!from_array).then(|| serde_json::Value::Object(parameters.clone()))
}

/// Brings an index of version 18 to 19 in place, in one transaction: `sessions.listed` gains `modelParameters`, derived from
/// the row's summary where that is lossless ([`listed_model_parameters`]); a row it cannot be derived for is marked dirty, so
/// the start's repairs write it from its log. A dirty row is left to its repair, which writes the member; a row with no log
/// under `data` (a pending row of the migration, which its adoption writes whole) keeps its members as they are. `Ok(false)`:
/// the file is not an index of version 18, and is left as it is.
#[allow(clippy::disallowed_methods, reason = "runs on the maintenance lane job of the index open")]
fn upgrade_from_18(data: &Path, path: &Path) -> Result<bool, DbError> {
    let Some(mut conn) = open_at_version(path, 18)? else { return Ok(false) };
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    {
        let rows: Vec<(String, Option<String>, String)> = tx
            .prepare("SELECT id, summary, listed FROM sessions WHERE listed IS NOT NULL AND dirty = 0 AND log_id <> ?1")?
            .query_map([PENDING_LOG_ID], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        let mut set = tx.prepare("UPDATE sessions SET listed = ?2 WHERE id = ?1")?;
        let mut repair = tx.prepare("UPDATE sessions SET dirty = 1 WHERE id = ?1")?;
        for (id, summary, listed) in rows {
            let summary = summary.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
            let parameters = summary.as_ref().and_then(listed_model_parameters);
            match (parameters, serde_json::from_str::<serde_json::Value>(&listed)) {
                (Some(parameters), Ok(serde_json::Value::Object(mut members))) => {
                    members.insert("modelParameters".to_owned(), parameters);
                    set.execute(params![id, serde_json::Value::Object(members).to_string()])?;
                }
                _ if data.join("sessions").join(&id).is_dir() => drop(repair.execute([id])?),
                _ => {}
            }
        }
    }
    tx.pragma_update(None, "user_version", 19)?;
    tx.commit()?;
    Ok(true)
}

/// The index version 20 adds, as `sql/index.sql` declares it; one that is there already (a file of the newer shape
/// stamped with the older version) is left.
const HISTORY_TURN_INDEX: &str = "CREATE INDEX IF NOT EXISTS history_turn ON history(session, turn, ordinal) WHERE model = 1";

/// Brings an index of version 19 to 20 in place, in one transaction: `history` gains its `history_turn` index, built from
/// the rows it holds (one pass over the table). `Ok(false)`: the file is not an index of version 19, and is left as it is.
fn upgrade_from_19(path: &Path) -> Result<bool, DbError> {
    let Some(mut conn) = open_at_version(path, 19)? else { return Ok(false) };
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute_batch(HISTORY_TURN_INDEX)?;
    tx.pragma_update(None, "user_version", 20)?;
    tx.commit()?;
    Ok(true)
}

/// The columns version 21 adds, as `sql/index.sql` declares them: `(table, column, declaration)`.
const VERSION_21_COLUMNS: [(&str, &str, &str); 2] =
    [("history", "end_form", "INTEGER NOT NULL DEFAULT 0"), ("turns", "end_form", "INTEGER NOT NULL DEFAULT 0")];

/// Brings an index of version 20 to 21 in place, in one transaction: the rows of `history` and `turns` gain the
/// columns of [`VERSION_21_COLUMNS`] at their defaults, which is what their logs say (a build that wrote an index of
/// 20 reads no log holding a turn's end form), and `compactions` its `cid` index. A
/// column that is there already is left. `Ok(false)`: the file is not an index of version 20, and is left as it is.
fn upgrade_from_20(path: &Path) -> Result<bool, DbError> {
    let Some(mut conn) = open_at_version(path, 20)? else { return Ok(false) };
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for (table, column, declaration) in VERSION_21_COLUMNS {
        let held: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)", params![table, column], |r| r.get(0))?;
        if !held {
            tx.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {declaration}"))?;
        }
    }
    tx.execute_batch("CREATE INDEX IF NOT EXISTS compactions_cid ON compactions(session, cid)")?;
    tx.pragma_update(None, "user_version", 21)?;
    tx.commit()?;
    Ok(true)
}

/// Whether an open of the index failed because of the file itself: another identity, or
/// bytes SQLite cannot read as a database.
pub(crate) fn needs_rebuild(e: &DbError) -> bool {
    match e {
        DbError::Rebuild(_) => true,
        DbError::Sqlite(e) => matches!(e.sqlite_error_code(), Some(rusqlite::ErrorCode::NotADatabase | rusqlite::ErrorCode::DatabaseCorrupt)),
        _ => false,
    }
}

/// How far one boot's index rebuild has come, in sessions. The boot makes one and hands it to its discovery publication (which
/// reads it) and to its store open (whose readers advance it as each session's log is read); no other open reports into it.
/// Absent (`None`) until a rebuild has begun, and so on a start that needs none.
#[derive(Default)]
pub struct RebuildProgress {
    done: std::sync::atomic::AtomicU64,
    total: std::sync::atomic::AtomicU64,
    /// Sessions of the work that failed: counted apart from `done`, never done in this boot.
    failed: std::sync::atomic::AtomicU64,
    /// Told after every change; set once by whoever publishes. It must not block: it runs on the rebuild's reader threads.
    changed: std::sync::OnceLock<Box<dyn Fn() + Send + Sync>>,
}

impl RebuildProgress {
    /// `(done, total)` sessions while a rebuild has begun; `None` before. It ends at `(total, total)`.
    pub fn snapshot(&self) -> Option<(u64, u64)> {
        use std::sync::atomic::Ordering::SeqCst;
        let total = self.total.load(SeqCst);
        (total > 0).then(|| (self.done.load(SeqCst).min(total), total))
    }

    /// Sets what is told after every change (the first call only).
    pub fn on_change(&self, changed: Box<dyn Fn() + Send + Sync>) {
        let _ = self.changed.set(changed);
    }

    pub fn begin(&self, total: usize) {
        use std::sync::atomic::Ordering::SeqCst;
        self.done.store(0, SeqCst);
        self.failed.store(0, SeqCst);
        self.total.store(total as u64, SeqCst);
        self.tell();
    }

    /// Adds `more` sessions of further work to what is counted, keeping what is done: a second step of the same boot (the owed rewrites of
    /// the sensitive marks) shows on the same bar, which never goes back.
    pub fn extend(&self, more: usize) {
        self.total.fetch_add(more as u64, std::sync::atomic::Ordering::SeqCst);
        self.tell();
    }

    pub fn advance(&self) {
        self.done.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.tell();
    }

    /// One session of the work failed: it is no longer to come, and it is not done.
    pub fn fail(&self) {
        self.failed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.tell();
    }

    /// How many sessions of the work failed ([`Self::fail`]).
    pub fn failed(&self) -> u64 {
        self.failed.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn tell(&self) {
        if let Some(changed) = self.changed.get() {
            changed();
        }
    }
}
/// Publishes over `path` an index that holds no session yet and owes each of `sessions` its rows ([`rebuild_key`]): the repairs
/// project them from their logs behind the serving core, those of `first` (all of them when `None`) before the rest. The old
/// file is marked unusable in itself, then its WAL and shared memory go, so they never pair with the new file; a crash
/// before the publish leaves a file that fails its open and is made anew again.
#[allow(clippy::disallowed_methods, reason = "runs on the maintenance lane job (lane proof argument)")]
fn fresh_index(
    _lane: &InLane<MaintenanceIo>,
    data: &Path,
    path: &Path,
    sessions: &[String],
    first: Option<&std::collections::HashSet<String>>,
) -> Result<(), DbError> {
    let failed = |e: String| DbError::Write(format!("index rebuild: {e}"));
    let dir = path.parent().expect("index file in a directory");
    crate::fsio::create_dir_durable(dir).map_err(|e| failed(e.to_string()))?;
    crate::fsio::sweep_tmp_unlaned(dir).map_err(|e| failed(e.to_string()))?;
    let staged = crate::fsio::tmp_path(path);
    {
        let mut conn = open_writer(&staged, Some(&runtime_ddl())).map_err(|e| failed(e.to_string()))?;
        let tx = conn.transaction().map_err(|e| failed(e.to_string()))?;
        {
            let mut owe = tx.prepare("INSERT INTO meta (key, value) VALUES (?1, ?2)").map_err(|e| failed(e.to_string()))?;
            for session in sessions {
                let mut written = last_written_ms(&data.join("sessions").join(session));
                if first.is_none_or(|first| first.contains(session)) {
                    written += REBUILD_FIRST;
                }
                owe.execute(params![rebuild_key(session), written.to_string()]).map_err(|e| failed(e.to_string()))?;
            }
        }
        tx.commit().map_err(|e| failed(e.to_string()))?;
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).map_err(|e| failed(e.to_string()))?;
        conn.pragma_update(None, "journal_mode", "DELETE").map_err(|e| failed(e.to_string()))?;
    }
    let whole = std::fs::OpenOptions::new().read(true).write(true).open(&staged).map_err(|e| failed(e.to_string()))?;
    crate::fsio::sync_file(&whole, &staged).map_err(|e| failed(e.to_string()))?;
    drop(whole);
    // Until the publish the old main file must not open as a clean index without its WAL: it is marked unusable first.
    if path.exists() {
        match Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).and_then(|old| {
            // Out of WAL mode first: the mark lands in the main file, not in the WAL removed next.
            old.pragma_update(None, "journal_mode", "DELETE")?;
            old.pragma_update(None, "user_version", 0)
        }) {
            Err(rusqlite::Error::SqliteFailure(e, _)) if matches!(e.code, rusqlite::ErrorCode::NotADatabase | rusqlite::ErrorCode::DatabaseCorrupt) => {}
            Err(e) => return Err(failed(e.to_string())),
            Ok(()) => {}
        }
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut side = path.as_os_str().to_owned();
        side.push(suffix);
        match std::fs::remove_file(&side) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(failed(e.to_string())),
            _ => {}
        }
    }
    crate::fsio::durable_rename(&staged, path).map_err(|e| failed(e.to_string()))
}

/// The sessions of `complete` that may hold a worker row, by the index being replaced at `path`: its worker and agent-only
/// rows, the rows behind their log (dirty, or holed), and the sessions it does not list. `None` when it cannot tell (no
/// file, or one it cannot read so): every session may then.
fn worker_candidates(path: &Path, complete: &[String]) -> Option<std::collections::HashSet<String>> {
    // Opened as it was left (its WAL read in): the file is replaced next, so nothing written to it here outlives the open.
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).ok()?;
    // A file that is not this index says nothing of any session: no "not a worker" is taken from it.
    let identity: i32 = conn.pragma_query_value(None, "application_id", |r| r.get(0)).ok()?;
    if identity != INDEX_APPLICATION_ID {
        return None;
    }
    let ids = |sql: &str| -> Option<std::collections::HashSet<String>> {
        let mut stmt = conn.prepare(sql).ok()?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).ok()?;
        rows.collect::<Result<_, _>>().ok()
    };
    let listed = ids("SELECT id FROM sessions")?;
    let mut first = ids("SELECT id FROM sessions WHERE worker IS NOT NULL OR worker_tag IS NOT NULL OR visibility = 'agent-only' OR dirty = 1")?;
    first.extend(ids("SELECT substr(key, 6) FROM meta WHERE key >= 'hole:' AND key < 'hole;'")?);
    first.extend(complete.iter().filter(|session| !listed.contains(*session)).cloned());
    Some(first)
}

/// The sessions whose rows are behind their log at open: marked dirty, or holed.
fn behind_their_log(c: &Connection) -> rusqlite::Result<Vec<String>> {
    c.prepare_cached("SELECT id FROM sessions WHERE dirty = 1 UNION SELECT substr(key, 6) FROM meta WHERE key >= 'hole:' AND key < 'hole;'")?
        .query_map([], |r| r.get(0))?
        .collect()
}

/// The sessions a rebuild still owes that could hold a worker row ([`REBUILD_FIRST`]), most recently written first. A debt
/// whose value does not say (it is no number) is one of them: only a recorded "not a candidate" leaves a session out.
fn rebuild_first(c: &Connection) -> rusqlite::Result<Vec<String>> {
    c.prepare_cached(
        "SELECT substr(key, 9) FROM meta WHERE key >= 'rebuild:' AND key < 'rebuild;'
         AND (CAST(value AS INTEGER) >= ?1 OR value NOT GLOB '[0-9]*')
         ORDER BY CAST(value AS INTEGER) DESC, key",
    )?
    .query_map([REBUILD_FIRST as i64], |r| r.get(0))?
    .collect()
}

/// The one set of worker candidates of an open, in the order they are repaired: what a reader of the worker rows waits for
/// ([`Need::Workers`]) and what the repairs take ahead of the rest of a rebuild. Every session behind its log (dirty, or
/// holed), whichever start projected or made it (its worker change may be in its log and not in the index), then the
/// sessions the rebuild recorded as candidates when it replaced the index.
fn worker_order(c: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut order = behind_their_log(c)?;
    let behind: HashSet<String> = order.iter().cloned().collect();
    order.extend(rebuild_first(c)?.into_iter().filter(|session| !behind.contains(session)));
    Ok(order)
}

/// When the session's log was last written (its newest log file's modification, ms since the epoch); 0 when unreadable.
#[allow(clippy::disallowed_methods, reason = "runs on the maintenance lane job of the index open")]
fn last_written_ms(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("log."))
        .filter_map(|entry| entry.metadata().ok()?.modified().ok())
        .filter_map(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|at| at.as_millis() as u64)
        .max()
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------------------
// Catalog rows

/// The list/search fields of one session, from its header (the caller maps the header).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CatalogRow {
    pub id: String,
    pub log_id: String,
    pub base_session: Option<String>,
    pub activity: f64,
    pub created_at: Option<f64>,
    pub updated_at: Option<f64>,
    pub closed: bool,
    pub archived_at: Option<f64>,
    pub cwd: Option<String>,
    pub visibility: Option<String>,
    pub owner_session_id: Option<String>,
    pub parent_session_id: Option<String>,
    pub agent: Option<String>,
    pub source_type: Option<String>,
    pub classification: Option<String>,
    pub archived: bool,
    /// Search inputs: the stored title and preview (the display title is derived),
    /// `projectPath`, `model`, `sourceName`.
    pub title: Option<String>,
    pub preview: Option<String>,
    pub project_path: Option<String>,
    pub model: Option<String>,
    pub source_name: Option<String>,
    /// The JSON list row.
    pub summary: String,
    /// The worker index keys of the header's `worker` map.
    pub worker: Option<crate::worker::WorkerKeys>,
    /// The header's `agentTag` and owner.
    pub agent_tag: Option<crate::worker::TagKeys>,
    /// The header's delete mark (`summary::is_deleted`); a row once deleted stays deleted.
    pub deleted: bool,
    /// The header's `title` when its `titleSource` is `user`.
    pub user_name: Option<String>,
    /// The header members a listing reads (`worker::listed_row`).
    pub listed: Option<String>,
}

/// FORMAT.md §8.2 `fold(x)`: Unicode default lowercase, no normalization.
pub fn fold(x: &str) -> String {
    x.to_lowercase()
}

/// The seven folds and the placeholder kind the writer stores for `row`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folds {
    pub title_kind: Option<TitleKind>,
    pub title: String,
    pub preview: Option<String>,
    pub cwd: Option<String>,
    pub project: Option<String>,
    pub id: String,
    pub model: Option<String>,
    pub source: Option<String>,
}

impl Folds {
    pub fn of(row: &CatalogRow, labels: &PlaceholderLabels) -> Folds {
        let (title, title_kind) = session_display_title(row.title.as_deref(), row.preview.as_deref(), labels);
        let f = |v: &Option<String>| v.as_deref().map(fold);
        Folds {
            title_kind,
            title: fold(&title),
            preview: f(&row.preview),
            cwd: f(&row.cwd),
            project: f(&row.project_path),
            id: fold(&row.id),
            model: f(&row.model),
            source: f(&row.source_name),
        }
    }
}

/// A catalog row as the index holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRow {
    /// The JSON list row.
    pub summary: String,
    pub archived: bool,
    pub deleted: bool,
    /// The name the user gave the session (`titleSource: user`), as Node's desktop kept it in `names`.
    pub user_name: Option<String>,
}

/// A catalog row write that changed the row: what the index held before it (`None`: no row) and what it holds now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowEdge {
    pub id: String,
    pub before: Option<StoredRow>,
    pub after: StoredRow,
}

/// Told, in write order and after the transaction that wrote them committed, of every row write that changed a row (Node's
/// `onSessionCatalogDbChange`). Called on the index writer thread: it must not block.
pub trait RowSink: Send + Sync {
    /// Before the transaction that wrote `count` changed rows commits: a reader that sees one of those rows was told of it here
    /// first. Each is then [`Self::written`] once committed, or all of them [`Self::dropped`] when the commit failed.
    fn writing(&self, _count: usize) {}
    fn written(&self, edge: RowEdge);
    /// The transaction told of in [`Self::writing`] did not commit: its `count` rows are never written.
    fn dropped(&self, _count: usize) {}
}

/// The sink of a store, set once after the store opens.
pub type RowSinkCell = Arc<std::sync::OnceLock<Arc<dyn RowSink>>>;

/// The archive authority's published snapshot, bound once after the store opens ([`SqliteStore::bind_archive`]).
type ArchiveCell = Arc<std::sync::OnceLock<crate::archive_state::ArchiveView>>;
use crate::archive_state::ArchiveSnapshot;

/// What an upsert does to the RL §9.2 dirty mark.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirtyMark {
    /// Header change while active: the mark stays as it is (new rows start dirty).
    Keep,
    /// Creation or activation.
    Set,
    /// Retire: the final summary.
    Clear,
}

/// [`SqliteStore::offload_referencers`].
#[derive(Debug, Default, PartialEq, Eq)]
pub struct OffloadReferencers {
    pub sessions: Vec<String>,
    pub unreadable: Option<String>,
    /// A copy still being made: the copy and the session it copies.
    pub copying: Option<(String, String)>,
    /// The sessions whose set is unknown, with the ordinal each is projected to.
    pub unknown: Vec<(String, i64)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    Ok,
    Damaged,
    Indeterminate,
}

impl SessionStatus {
    fn as_str(self) -> &'static str {
        match self {
            SessionStatus::Ok => "ok",
            SessionStatus::Damaged => "damaged",
            SessionStatus::Indeterminate => "indeterminate",
        }
    }
}

/// The one write of a session's damage state (FORMAT.md §3.4), live and rebuild alike.
fn set_status_on(tx: &Transaction, session: &str, status: SessionStatus, damage: Option<&str>) -> rusqlite::Result<()> {
    tx.prepare_cached("UPDATE sessions SET status = ?2, damage = ?3 WHERE id = ?1")?.execute(params![session, status.as_str(), damage])?;
    Ok(())
}

/// A deleted session no other session forks from (a purged fork takes its edge with it).
const PURGEABLE_SQL: &str = "SELECT id FROM sessions s WHERE deleted = 1
    AND NOT EXISTS (SELECT 1 FROM fork_edges e WHERE e.base = s.id) LIMIT 1";
/// The next session [`PURGEABLE_SQL`] could answer that does not owe its sensitive rewrite (a purge while serving).
const PURGEABLE_ALL_SQL: &str = "SELECT id FROM sessions s WHERE deleted = 1
    AND NOT EXISTS (SELECT 1 FROM fork_edges e WHERE e.base = s.id)
    AND NOT EXISTS (SELECT 1 FROM withheld_sessions w WHERE w.id = s.id) LIMIT 1";

/// The tables holding a session's rows, with their keys: a purge step deletes by key.
const PURGE_TABLES: [(&str, &str); 19] = [
    ("offload_refs", "source, session"),
    ("offload_known", "session"),
    ("offload_marks", "session"),
    ("archived_agents", "session, child"),
    ("history", "session, ordinal"),
    ("history_alias", "session, alias, ordinal"),
    ("model_switches", "session, ordinal"),
    ("amends", "session, ordinal"),
    ("compactions", "session, ordinal"),
    ("compaction_dropped", "session, kind, id, ordinal"),
    ("message_rows", "session, ordinal, idx, ver"),
    ("message_epochs", "session, start"),
    ("message_views", "session, valid_from"),
    ("turns", "session, rid"),
    ("approvals", "session, aid"),
    ("prompt_occurrences", "session, ordinal"),
    ("prompt_history", "session, key"),
    ("thread_ops", "session, op_id"),
    ("submissions", "session, submission_id"),
];

/// The folder of a deleted session, gone: the first log file first, so a rebuild never
/// indexes a half-removed folder. Already-removed parts are skipped.
#[allow(clippy::disallowed_methods, reason = "runs on the maintenance lane job (lane proof argument)")]
fn remove_session_dir(_lane: &InLane<MaintenanceIo>, dir: &Path) -> Result<(), DbError> {
    use crate::fsio::IoOp;
    let _writing = crate::log_epoch::writing_dir(dir);
    let gone = |r: std::io::Result<()>, op: IoOp, path: &Path| match r {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(DbError::Write(crate::fsio::err(op, path)(e).to_string())),
        _ => Ok(()),
    };
    let first = dir.join(crate::log::log_name(0));
    gone(std::fs::remove_file(&first), IoOp::Remove, &first)?;
    if dir.is_dir() {
        crate::fsio::sync_dir(dir).map_err(|e| DbError::Write(e.to_string()))?;
    }
    gone(std::fs::remove_dir_all(dir), IoOp::Remove, dir)?;
    let parent = dir.parent().expect("session folder in `sessions`");
    crate::fsio::sync_dir(parent).map_err(|e| DbError::Write(e.to_string()))
}

/// Removes folders without a first log. Only a rebuild needs the ids of the complete folders;
/// gather those during this same walk rather than repeating the directory and log-file probes.
#[allow(clippy::disallowed_methods, reason = "runs on the maintenance lane job (lane proof argument)")]
fn scan_session_dirs(lane: &InLane<MaintenanceIo>, sessions: &Path, rebuilding: bool) -> Result<(Vec<String>, Vec<String>), DbError> {
    let entries = match std::fs::read_dir(sessions) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), Vec::new())),
        Err(e) => return Err(DbError::Write(format!("{}: {e}", sessions.display()))),
    };
    let mut incomplete = Vec::new();
    let mut complete = Vec::new();
    let first_log = crate::log::log_name(0);
    for entry in entries {
        let entry = entry.map_err(|e| DbError::Write(format!("{}: {e}", sessions.display())))?;
        let Ok(name) = entry.file_name().into_string() else { continue };
        let dir = entry.path();
        if dir.join(&first_log).is_file() {
            if rebuilding {
                complete.push(name);
            }
        } else if dir.is_dir() {
            incomplete.push(name);
        }
    }
    incomplete.sort();
    for id in &incomplete {
        remove_session_dir(lane, &sessions.join(id))?;
    }
    complete.sort();
    Ok((incomplete, complete))
}

/// The agent-only sessions in list order (`sessions_visibility_recent`).
pub(crate) const AGENT_ONLY_SQL: &str = "SELECT summary, EXISTS (SELECT 1 FROM withheld_sessions w WHERE w.id = sessions.id)
    FROM sessions WHERE visibility = 'agent-only'
    AND deleted = 0 AND log_id <> '' ORDER BY activity DESC, id";

const UPSERT_SQL: &str = "
INSERT INTO sessions (id, dirty, status, damage, deleted, base_session, log_id, newest_file_no,
    projected_file_no, projected_offset, projected_ordinal, history_rev, row_count, visible_count,
    activity, created_at, updated_at, closed, archived_at, cwd, visibility, owner_session_id,
    parent_session_id, agent, source_type, classification, archived, title_kind, id_key,
    title_fold, preview_fold, cwd_fold, project_fold, id_fold, model_fold, source_fold, summary,
    title, worker, worker_tag, worker_owner, worker_host_pid, agent_tag, agent_owner, user_name, listed)
VALUES (?1, ?2, 'ok', NULL, ?36, ?3, ?4, 0, 0, 0, 0, 0, 0, 0,
    ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
    ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?37, ?38)
ON CONFLICT(id) DO UPDATE SET
    dirty = CASE WHEN ?28 THEN dirty ELSE excluded.dirty END,
    deleted = max(deleted, excluded.deleted),
    activity = excluded.activity, created_at = excluded.created_at,
    updated_at = excluded.updated_at, closed = excluded.closed, archived_at = excluded.archived_at,
    cwd = excluded.cwd, visibility = excluded.visibility,
    owner_session_id = excluded.owner_session_id, parent_session_id = excluded.parent_session_id,
    agent = excluded.agent, source_type = excluded.source_type,
    classification = excluded.classification, archived = excluded.archived,
    title_kind = excluded.title_kind, title_fold = excluded.title_fold,
    preview_fold = excluded.preview_fold, cwd_fold = excluded.cwd_fold,
    project_fold = excluded.project_fold, id_fold = excluded.id_fold,
    model_fold = excluded.model_fold, source_fold = excluded.source_fold,
    summary = excluded.summary, title = excluded.title, worker = excluded.worker,
    worker_tag = excluded.worker_tag, worker_owner = excluded.worker_owner,
    worker_host_pid = excluded.worker_host_pid, agent_tag = excluded.agent_tag,
    agent_owner = excluded.agent_owner, user_name = excluded.user_name, listed = excluded.listed";

/// `sessions.listed` of each session the index can answer for, in order ([`SqliteStore::listed`]).
fn listed_on(c: &Connection, sessions: &[String]) -> Result<Vec<Option<Option<String>>>, DbError> {
    // A fork whose inherited state is still being computed keeps the row it had (`upsert_edge`): that row does not hold
    // what its log says since. A session owing its sensitive rewrite is one the index cannot answer for (decided in the
    // statement that reads the row): its record is the source, and refuses it.
    let mut row = c.prepare_cached(
        "SELECT listed FROM sessions WHERE id = ?1 AND log_id <> '' AND deleted = 0 AND dirty = 0 AND status = 'ok'
         AND NOT EXISTS (SELECT 1 FROM withheld_sessions w WHERE w.id = sessions.id)
         AND coalesce((SELECT state FROM message_views v WHERE v.session = sessions.id ORDER BY valid_from DESC LIMIT 1), '') <> 'pending'",
    )?;
    sessions.iter().map(|session| Ok(row.query_row([session], |r| r.get::<_, Option<String>>(0)).optional()?)).collect()
}

/// A `sessions` row's withheld state, as a column of the statement that reads the row: the row and the decision are one
/// snapshot ([`withheld`]).
pub(crate) const WITHHELD_COL: &str = "EXISTS (SELECT 1 FROM withheld_sessions w WHERE w.id = sessions.id)";

/// Writes the catalog row of `head` with the message state projected so far; the bytes
/// of the list row.
fn upsert(
    tx: &Transaction<'_>,
    head: &CatalogHead,
    dirty: DirtyMark,
    labels: &PlaceholderLabels,
    archive: Option<&ArchiveSnapshot>,
) -> rusqlite::Result<usize> {
    upsert_edge(tx, head, dirty, labels, false, archive).map(|(written, _)| written)
}

/// The archive state of `row` as the archive authority resolves it ([`crate::archive_state`]): an entry overrides the header's
/// stamp. Without an authority bound (a rebuild before the core binds it, a store of a test) the header's stamp stands; the
/// binding projects every entry afterwards.
fn resolve_archive(row: &mut CatalogRow, archive: Option<&ArchiveSnapshot>) {
    if let Some(entry) = archive.and_then(|archive| archive.entry(&row.id)) {
        row.archived_at = entry.archived_at();
        row.archived = row.archived_at.is_some();
    }
}

/// The snapshot the index resolves through, once bound.
fn bound_archive(cell: &ArchiveCell) -> Option<Arc<ArchiveSnapshot>> {
    cell.get().map(crate::archive_state::current)
}

/// [`upsert`], and with `watch` the change it made to the row.
fn upsert_edge(
    tx: &Transaction<'_>,
    head: &CatalogHead,
    dirty: DirtyMark,
    labels: &PlaceholderLabels,
    watch: bool,
    archive: Option<&ArchiveSnapshot>,
) -> rusqlite::Result<(usize, Option<RowEdge>)> {
    write_offload_refs(tx, head)?;
    // A fork whose inherited state is still being computed keeps its row until it is done.
    if crate::message_index::has_pending_view(tx, &head.session)? {
        return Ok((0, None));
    }
    let with_incoming = crate::agent_mode::wants_incoming_tail(&head.session);
    let stats = crate::message_index::read_stats(tx, &head.session, with_incoming)?.into_stats(&head.session);
    let mut row = crate::summary::catalog_row(head, &stats, now_ms());
    resolve_archive(&mut row, archive);
    let before = if watch { stored_row(tx, &row.id)? } else { None };
    write_row(tx, &row, dirty, labels)?;
    tx.prepare_cached("DELETE FROM archived_agents WHERE session = ?1")?.execute([&head.session])?;
    for child in crate::archived_agent::children(&head.header) {
        tx.prepare_cached("INSERT INTO archived_agents (session, child) VALUES (?1, ?2)")?.execute([&head.session, &child])?;
    }
    let after = StoredRow { summary: row.summary.clone(), archived: row.archived, deleted: row.deleted, user_name: row.user_name.clone() };
    let edge = (watch && before.as_ref() != Some(&after)).then(|| RowEdge { id: row.id.clone(), before, after });
    Ok((row.summary.len(), edge))
}

fn add_offload_ref(tx: &Transaction<'_>, session: &str, source: &str) -> rusqlite::Result<()> {
    tx.prepare_cached("INSERT OR IGNORE INTO offload_refs (source, session) VALUES (?1, ?2)")?
        .execute(params![crate::offload_sources::segment_key(source), session])?;
    Ok(())
}

fn write_offload_refs(tx: &Transaction<'_>, head: &CatalogHead) -> rusqlite::Result<()> {
    use crate::offload_sources as sets;
    tx.prepare_cached("DELETE FROM offload_marks WHERE session = ?1")?.execute([&head.session])?;
    if let Some((source, boot)) = sets::mark(&head.header) {
        tx.prepare_cached("INSERT INTO offload_marks (session, source, boot) VALUES (?1, ?2, ?3)")?.execute(params![head.session, source, boot])?;
    }
    let holds_set = sets::holds_set(&head.header);
    if holds_set {
        tx.prepare_cached("DELETE FROM offload_refs WHERE session = ?1")?.execute([&head.session])?;
    }
    for source in sets::sources(&head.header) {
        add_offload_ref(tx, &head.session, &source)?;
    }
    if holds_set {
        tx.prepare_cached("INSERT INTO offload_known (session, ordinal, rules) VALUES (?1, NULL, ?2) ON CONFLICT(session) DO UPDATE SET ordinal = NULL, rules = excluded.rules")?
            .execute(params![head.session, sets::RULES])?;
    } else {
        tx.prepare_cached("DELETE FROM offload_known WHERE session = ?1 AND ordinal IS NULL")?.execute([&head.session])?;
    }
    Ok(())
}

/// A scan of the transcript of `session`, a session whose header holds no set under the present rules, at `ordinal`:
/// its `sources` join its rows and it is known at that ordinal under those rules, unless it was projected past it
/// meanwhile (or gained a set) - then the next prune scans it again.
fn record_offload_scan(tx: &Transaction<'_>, session: &str, ordinal: i64, sources: &[String]) -> rusqlite::Result<()> {
    use crate::offload_sources as sets;
    let current: Option<i64> = tx.prepare_cached("SELECT projected_ordinal FROM sessions WHERE id = ?1")?.query_row([session], |r| r.get(0)).optional()?;
    let from_header: bool = tx
        .prepare_cached("SELECT EXISTS (SELECT 1 FROM offload_known WHERE session = ?1 AND ordinal IS NULL AND rules = ?2)")?
        .query_row(params![session, sets::RULES], |r| r.get(0))?;
    // A cursor that rows lie past names no state of the transcript: a scan at it is never current.
    if current != Some(ordinal) || from_header || !contiguous(tx, session)? {
        return Ok(());
    }
    for source in sources {
        add_offload_ref(tx, session, source)?;
    }
    tx.prepare_cached("INSERT INTO offload_known (session, ordinal, rules) VALUES (?1, ?2, ?3) ON CONFLICT(session) DO UPDATE SET ordinal = excluded.ordinal, rules = excluded.rules")?
        .execute(params![session, ordinal, sets::RULES])?;
    Ok(())
}

fn write_row(tx: &Transaction<'_>, row: &CatalogRow, dirty: DirtyMark, labels: &PlaceholderLabels) -> rusqlite::Result<()> {
    let folds = Folds::of(row, labels);
    tx.prepare_cached(UPSERT_SQL)?.execute(params![
        row.id,
        dirty != DirtyMark::Clear,
        row.base_session,
        row.log_id,
        row.activity,
        row.created_at,
        row.updated_at,
        row.closed,
        row.archived_at,
        row.cwd,
        row.visibility,
        row.owner_session_id,
        row.parent_session_id,
        row.agent,
        row.source_type,
        row.classification,
        row.archived,
        folds.title_kind.map(TitleKind::as_str),
        session_id_key(&row.id),
        folds.title,
        folds.preview,
        folds.cwd,
        folds.project,
        folds.id,
        folds.model,
        folds.source,
        row.summary,
        dirty == DirtyMark::Keep,
        row.title,
        row.worker.as_ref().map(|w| &w.map),
        row.worker.as_ref().map(|w| &w.tag),
        row.worker.as_ref().and_then(|w| w.owner.as_ref()),
        row.worker.as_ref().and_then(|w| w.host_pid),
        row.agent_tag.as_ref().map(|t| &t.tag),
        row.agent_tag.as_ref().map(|t| &t.owner),
        row.deleted,
        row.user_name,
        row.listed,
    ])?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Writer

type Ack = oneshot::Sender<Result<(), DbError>>;
/// The answer to a repair's work, which goes back to the queue with it until it is done.
type RepairAck = mpsc::Sender<Result<(), DbError>>;

/// The wait for the writer's answer to a projection already queued at it ([`SqliteStore::queue_projection`]).
pub type Committed = std::pin::Pin<Box<dyn Future<Output = Result<(), DbError>> + Send>>;

/// A session whose log a sensitive rewrite replaced (`log_rewrite`'s step 6): its rows to rebuild under `<data>/sessions`.
/// The rewrite deletes no blob (the ownership ledger's roots change, `log_rewrite::finish`).
pub struct Rewritten {
    pub data: PathBuf,
    pub session: String,
    pub dirty: DirtyMark,
}

enum Command {
    Upsert {
        head: Arc<CatalogHead>,
        dirty: DirtyMark,
        ack: Option<Ack>,
    },
    /// Refused when the index holds no row of `session` for the log `log_id`: nothing was marked. The mark names
    /// `activation` ([`mark_key`]).
    MarkDirty {
        session: String,
        log_id: String,
        activation: u64,
        ack: Ack,
    },
    Status {
        session: String,
        status: SessionStatus,
        damage: Option<String>,
        ack: Ack,
    },
    Delete {
        session: String,
        ack: Ack,
    },
    Project {
        projection: Projection,
        ack: Option<Ack>,
    },
    /// The last projection of a journal writer that closed cleanly ([`SqliteStore::queue_retirement`]): its frames in the
    /// session's projection order, then the session's row, written clean when the index holds the log through its end.
    Retire {
        projection: Projection,
        retirement: Retirement,
        ack: Ack,
    },
    Labels {
        labels: PlaceholderLabels,
        ack: Ack,
    },
    OffloadScan {
        session: String,
        ordinal: i64,
        sources: Vec<String>,
        ack: Ack,
    },
    /// A pending row takes the identity of the log that is there now ([`Adopting::arrived`]).
    Arrived {
        session: String,
        log_id: String,
        base_session: Option<String>,
        ack: Ack,
    },
    /// The list rows of the sessions still to be converted ([`SqliteStore::list_pending`]).
    Pending {
        sessions: Vec<(CatalogHead, crate::summary::MessageStats)>,
        ack: Ack,
    },
    /// The rows of these sessions take their archive entries ([`SqliteStore::project_archive`]).
    Archive {
        sessions: Vec<String>,
        read: Arc<std::sync::atomic::AtomicU64>,
        ack: Ack,
    },
    /// Drop the index rows of a deleted session whose folder is gone.
    Purge {
        session: String,
        ack: Ack,
    },
    /// Exactly these sessions are withheld ([`SqliteStore::withhold`]).
    Withhold {
        sessions: Vec<String>,
        ack: Ack,
    },
    /// A withheld session, its rows rebuilt from its rewritten log, is answered in full from the commit on, and its row is
    /// told as changed ([`SqliteStore::release_withheld`]).
    Release {
        session: String,
        ack: Ack,
    },
    /// Test support: `session`'s index row of the op `op_id` removed ([`SqliteStore::forget_thread_op`]); refused when there is none.
    #[cfg(any(test, feature = "test-support"))]
    ForgetThreadOp {
        session: String,
        op_id: String,
        ack: Ack,
    },
    /// One piece of the work of rebuilding a session's rows from its log ([`RepairWork`]): applied a transaction at a
    /// time behind what the serving core writes ([`Writer::repair_step`]). Answered, after the commit that completes it,
    /// on a channel its sender (a repair thread, a lane job) blocks on.
    Repair {
        work: RepairWork,
        ack: mpsc::Sender<Result<(), DbError>>,
    },
    /// The writer stops at once and closes its connection ([`SqliteStore::close`]).
    Close,
}

impl Command {
    fn closes(&self) -> bool {
        matches!(self, Command::Close)
    }
}

/// What is left of one writer transaction (SPEC R31): room is taken before the rows are written.
#[derive(Debug, Clone, Copy)]
struct Budget {
    rows: usize,
    bytes: usize,
    cap: usize,
}

impl Budget {
    fn new(cap: usize) -> Budget {
        Budget { rows: cap, bytes: APPEND_BYTES, cap }
    }

    /// Room for `rows` more rows, taken when there is.
    fn reserve(&mut self, rows: usize) -> bool {
        let bytes = 64 * rows;
        if rows > self.rows || bytes > self.bytes {
            return false;
        }
        self.rows -= rows;
        self.bytes -= bytes;
        true
    }

    /// Nothing was taken from it: what does not fit it fits no transaction.
    fn fresh(&self) -> bool {
        self.rows == self.cap && self.bytes == APPEND_BYTES
    }

    /// `rows` written by an operation that sized itself to what was left.
    fn charge(&mut self, rows: usize) {
        self.rows = self.rows.saturating_sub(rows);
        self.bytes = self.bytes.saturating_sub(64 * rows);
    }

    #[cfg(test)]
    fn used(&self) -> usize {
        self.cap - self.rows
    }
}

/// Rows a transaction keeps for a session's row, its damage and its debt.
const ROW_ROOM: usize = 4;

/// Work a repair hands the writer. Each is resumable: a dispatch applies one transaction of it within a [`Budget`], and
/// the writer looks at what the serving core queued before the next.
enum RepairWork {
    /// The rows of a session about to be replayed from its log go, [`STEP_ROWS`] a transaction, its fork edge kept. Its
    /// hole is recorded in the first of those transactions, before any row goes.
    Purge { session: String, started: bool },
    /// Frames of a session's log, in order.
    Replay(Box<Replay>),
    /// The folded row, with which the session's debt is cleared.
    Finish(Box<Finish>),
    /// What a session whose folder is gone was owed.
    Forget { session: String },
}

impl RepairWork {
    fn session(&self) -> &str {
        match self {
            RepairWork::Purge { session, .. } | RepairWork::Forget { session } => session,
            RepairWork::Replay(replay) => &replay.session,
            RepairWork::Finish(finish) => &finish.session,
        }
    }
}

/// Frames of the session `session`, read from its log ([`RepairWork::Replay`]).
struct Replay {
    session: String,
    /// The session the frames were folded as.
    frames_session: String,
    /// The head at the log's `session` frame, for a session the index holds no row of: written dirty before the frames.
    start: Option<CatalogHead>,
    frames: Vec<ProjectedFrame>,
    /// Where it goes on: the next frame, and how much of that frame is in ([`apply_frame_part`]).
    next: usize,
    part: usize,
    /// The folded row, when the session was read whole: it is then tried as one savepoint of a transaction shared with
    /// other whole sessions, and nothing of it is committed apart.
    finish: Option<Finish>,
    /// It does not fit one transaction: it is applied in parts.
    split: bool,
    /// Part of it is committed: the session is holed until its complete row.
    partial: bool,
}

impl Replay {
    /// A session read whole of which nothing is committed, to be tried as one savepoint.
    fn whole(&self) -> bool {
        self.finish.is_some() && !self.split && !self.partial
    }
}

/// The row of a session's folded log ([`RepairWork::Finish`]).
struct Finish {
    session: String,
    head: CatalogHead,
    damage: Option<String>,
    dirty: DirtyMark,
    /// A repair owed at open, which the gate certifies: the row sink is told of the row it leaves, and the session's debt
    /// goes only in the transaction that writes its row, a fork's after its view.
    recovery: bool,
    /// The rows were replaced from a rewritten or refolded log: the WAL is truncated once the row is in.
    replaced: bool,
    /// The row waits for the fork's view, which the next dispatches compute.
    viewing: bool,
}

/// The end of a journal writer that was closed cleanly: the log it wrote and where its last frame ends (the position the
/// next frame would take). The session's dirty mark is cleared only with the row of an index that holds exactly that.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Retirement {
    pub log_id: String,
    pub end: FramePos,
    /// The activation whose mark this retirement clears ([`SqliteStore::mark_dirty`]): no other's.
    pub activation: u64,
}

/// A number for one activation of a session's journal writer, unlike any other this process or another gives: the process
/// id, and a count that starts at the clock.
pub fn new_activation() -> u64 {
    static NEXT: std::sync::OnceLock<std::sync::atomic::AtomicU64> = std::sync::OnceLock::new();
    let next = NEXT.get_or_init(|| {
        let micros = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_micros() as u64);
        std::sync::atomic::AtomicU64::new(micros)
    });
    let count = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed) & ((1 << 47) - 1);
    (u64::from(std::process::id() & 0xFFFF) << 47) | count
}

/// A retirement whose frames are in and whose row is still to be written.
struct Retiring {
    retirement: Retirement,
    ack: Ack,
}

/// The sessions a start has to repair, in id order: those marked dirty, and those whose rows hold frames past their cursor
/// ([`hole_key`]), whatever a repair that was cut off left of their row (none, or a clean one with its frames not yet in).
fn owed_repairs(c: &Connection) -> rusqlite::Result<Vec<String>> {
    c.prepare_cached(
        "SELECT id FROM sessions WHERE dirty = 1 UNION SELECT substr(key, 6) FROM meta WHERE key >= 'hole:' AND key < 'hole;'
         UNION SELECT substr(key, 9) FROM meta WHERE key >= 'rebuild:' AND key < 'rebuild;' ORDER BY 1",
    )?
    .query_map([], |r| r.get(0))?
    .collect()
}

/// The sessions a rebuild of the index still owes ([`rebuild_key`]), most recently written first: the order they are projected
/// in, so the top of the session list fills in first.
fn rebuild_order(c: &Connection) -> rusqlite::Result<Vec<String>> {
    c.prepare_cached("SELECT substr(key, 9) FROM meta WHERE key >= 'rebuild:' AND key < 'rebuild;' ORDER BY CAST(value AS INTEGER) DESC, key")?
        .query_map([], |r| r.get(0))?
        .collect()
}

/// The `meta` key of a session a rebuild of the index owes its rows (its value: when its log was last written, in ms). Written
/// for every session when the index is made anew, it goes in the transaction that writes the session's complete row, so a stop
/// or a kill leaves the rest owed to the next start.
pub(crate) fn rebuild_key(session: &str) -> String {
    format!("rebuild:{session}")
}

/// The `meta` key naming the activation that marked `session` (FORMAT.md §8.2), written in the mark's transaction.
fn mark_key(session: &str) -> String {
    format!("mark:{session}")
}

/// Whether the index holds every frame of `session` before its cursor and none after it: no projection of it was missed
/// with later ones taken ([`hole_key`]). Only then is the row's state the log's state at the cursor.
pub(crate) fn contiguous(tx: &Transaction<'_>, session: &str) -> rusqlite::Result<bool> {
    Ok(!tx.prepare_cached("SELECT 1 FROM meta WHERE key = ?1")?.exists([hole_key(session)])?)
}

/// Why the row of `session` cannot be written clean for `retiring`, read in the transaction that writes the row: the mark
/// is another activation's (this process's or another's, set since the writer closed), or the index does not hold the
/// retired log through its end (a projection of it was never taken, so the cursor stopped at the first one missing).
fn retire_refusal(tx: &Transaction<'_>, session: &str, retiring: &Retiring) -> rusqlite::Result<Option<String>> {
    let Retirement { log_id, end, activation } = &retiring.retirement;
    let marked: Option<String> = tx.prepare_cached("SELECT value FROM meta WHERE key = ?1")?.query_row([mark_key(session)], |r| r.get(0)).optional()?;
    if marked.as_deref() != Some(activation.to_string().as_str()) {
        return Ok(Some(format!("{session}: the mark is not this writer's activation {activation} (it names {marked:?})")));
    }
    let row = tx
        .prepare_cached("SELECT log_id, projected_ordinal, projected_file_no, projected_offset FROM sessions WHERE id = ?1")?
        .query_row([session], |r| {
            Ok((r.get::<_, String>(0)?, FramePos { ordinal: r.get::<_, i64>(1)? as u64, file_no: r.get(2)?, offset: r.get::<_, i64>(3)? as u64 }))
        })
        .optional()?;
    Ok(match row {
        None => Some(format!("{session}: the index holds no row of it")),
        Some((held, _)) if held != *log_id => Some(format!("{session}: the index holds the log {held}, not {log_id}")),
        Some((_, cursor)) if cursor != *end => Some(format!("{session}: the index holds the log to {cursor:?}, not to its end {end:?}")),
        Some(_) => None,
    })
}

/// Where the first frame of a projection lies against the index's cursor of its session.
enum Placed {
    /// It continues what the index holds: it takes the ordinal the index projects next, or it is the `session` frame of a
    /// row nothing was projected into (or the session has no row yet).
    Next,
    /// It lies past the cursor: the projection was queued after one the index never took, and the cursor is at the first
    /// frame missing.
    Past(FramePos),
    /// It lies before the cursor: the index holds it.
    Behind(FramePos),
}

fn placed(tx: &Transaction<'_>, session: &str, frame: &ProjectedFrame) -> rusqlite::Result<Placed> {
    let cursor = tx
        .prepare_cached(PROJECTED_SQL)?
        .query_row([session], |r| Ok(FramePos { ordinal: r.get::<_, i64>(0)? as u64, file_no: r.get(1)?, offset: r.get::<_, i64>(2)? as u64 }))
        .optional()?;
    Ok(match cursor {
        None => Placed::Next,
        Some(FramePos { file_no: 0, offset: 0, .. }) if matches!(frame.kind, FrameKind::Session { .. }) => Placed::Next,
        Some(cursor @ FramePos { file_no: 0, offset: 0, .. }) => Placed::Past(cursor),
        Some(cursor) if frame.pos.ordinal > cursor.ordinal => Placed::Past(cursor),
        Some(cursor) if frame.pos.ordinal < cursor.ordinal => Placed::Behind(cursor),
        Some(_) => Placed::Next,
    })
}

/// What an append transaction was doing when it failed: whose failure it is ([`Writer::append_transaction`]).
enum Failing {
    /// It did not begin. Still locked by a foreign connection after [`LOCK_WAIT`], nothing was tried and nothing queued
    /// is at fault; any other error is the failure of everything queued.
    Begin,
    /// A small command, which is answered with the failure.
    Small,
    /// The frames or the row of this session.
    Session(String),
    /// The commit of everything it held.
    Commit,
}

/// A catalog row an append transaction wrote, held until its commit: put back as it was queued when the transaction fails
/// on another session.
struct WrittenRow {
    id: String,
    upsert: Upsert,
    retiring: Option<Retiring>,
    refusal: Option<String>,
    written: usize,
}

/// The `meta` key of a session whose rows hold frames past its cursor (FORMAT.md §8.2): a projection of it was never taken
/// and later ones were. Its rows cannot be continued from the cursor; they are rebuilt from its log ([`Writer::reproject`]).
pub(crate) fn hole_key(session: &str) -> String {
    format!("hole:{session}")
}

/// The `meta` keys of a session whose rows are complete or purged for good: it is neither marked nor owed a repair.
fn forget_keys(c: &Connection, session: &str) -> rusqlite::Result<()> {
    c.prepare_cached("DELETE FROM meta WHERE key IN (?1, ?2, ?3)")?.execute([hole_key(session), mark_key(session), rebuild_key(session)])?;
    Ok(())
}

/// The end of what a session was owed (its hole and its rebuild): nothing is left to rebuild its rows from.
fn clear_debt(c: &Connection, session: &str) -> rusqlite::Result<()> {
    c.prepare_cached("DELETE FROM meta WHERE key IN (?1, ?2)")?.execute([hole_key(session), rebuild_key(session)])?;
    Ok(())
}

/// A projection being applied: frames before `next` are committed.
struct Pending {
    projection: Projection,
    next: usize,
    ack: Option<Ack>,
    /// Arrival order among projections and upserts.
    seq: u64,
    /// The projection is its writer's last ([`Command::Retire`]).
    retire: Option<Retirement>,
    /// The cursor the session keeps while this projection's frames go in ([`hole_before`]).
    hole: Option<FramePos>,
}

/// What the small commands of one append transaction read: the archive snapshot, the sequence it was read at, and whether a sink watches.
struct SmallEnv<'a> {
    archive: Option<&'a ArchiveSnapshot>,
    read_seq: u64,
    watch: bool,
}

/// What the small commands of one append transaction leave for its commit: the acks to send, the requests it answers
/// with a refusal of their own, and the rows they changed.
struct SmallOut<'a> {
    acks: &'a mut Vec<Ack>,
    refused: &'a mut Vec<(Ack, String)>,
    edges: &'a mut Vec<RowEdge>,
}

/// What every session of one [`Writer::replay_whole`] transaction is written with: the labels, whether a sink watches, and
/// the archive snapshot.
#[derive(Clone, Copy)]
struct WholeEnv<'a> {
    labels: &'a PlaceholderLabels,
    watch: bool,
    archive: Option<&'a ArchiveSnapshot>,
}

/// One whole session of a rebuild inside a savepoint of [`Writer::replay_whole`]: the row dirty at the log's first frame,
/// the frames, then the folded row clean with its damage, and with that row the session's debt and mark. Every row is
/// taken from `budget` before it is written; `false` as soon as one does not fit, and the caller undoes the savepoint. The
/// row changes join `edges`.
fn whole_on(
    tx: &Transaction<'_>,
    replay: &Replay,
    finish: &Finish,
    env: WholeEnv<'_>,
    edges: &mut Vec<RowEdge>,
    budget: &mut Budget,
) -> rusqlite::Result<bool> {
    let WholeEnv { labels, watch, archive } = env;
    if !budget.reserve(ROW_ROOM + usize::from(replay.start.is_some())) {
        return Ok(false);
    }
    let watch = watch && !withheld::is_withheld_in(tx, &replay.session)?;
    let started = match &replay.start {
        Some(start) => upsert_edge(tx, start, DirtyMark::Set, labels, watch, archive)?.1,
        None => None,
    };
    let (mut next, mut part) = (0, 0);
    if !apply_frames(tx, &replay.frames_session, &replay.frames, &mut next, &mut part, budget)? {
        return Ok(false);
    }
    let (written, finished) = upsert_edge(tx, &finish.head, DirtyMark::Clear, labels, watch, archive)?;
    if written > budget.bytes {
        return Ok(false);
    }
    budget.bytes -= written;
    // One change is told, from the row a reader saw before the savepoint (none, for a session the rebuild has not reached) to
    // the folded one: the row written at the first frame is gone before the commit.
    edges.extend(match (started, finished) {
        (Some(started), Some(finished)) => Some(RowEdge { before: started.before, ..finished }),
        (Some(started), None) => Some(started),
        (None, finished) => finished,
    });
    if let Some(damage) = &finish.damage {
        set_status_on(tx, &replay.session, SessionStatus::Damaged, Some(damage))?;
    }
    forget_keys(tx, &replay.session)?;
    Ok(true)
}

/// One bounded step of purging `session`'s index rows: at most `rows` deletions, its fork edge (one per child) and
/// catalog row counted, those two last. `true` once the catalog row is gone. With `keep_edge` (the purge that starts a
/// replay of the session's log) the fork edge stays, so the base it names is at no moment a session nothing forks from.
fn purge_slice(tx: &Transaction<'_>, session: &str, keep_edge: bool, rows: usize) -> rusqlite::Result<bool> {
    let mut budget = rows;
    for (table, key) in PURGE_TABLES {
        let sql = format!("DELETE FROM {table} WHERE ({key}) IN (SELECT {key} FROM {table} WHERE session = ?1 LIMIT ?2)");
        budget -= tx.prepare_cached(&sql)?.execute(params![session, budget as i64])?;
        if budget == 0 {
            return Ok(false);
        }
    }
    if !keep_edge {
        budget -= tx.prepare_cached("DELETE FROM fork_edges WHERE child = ?1")?.execute([session])?;
        if budget == 0 {
            return Ok(false);
        }
    }
    tx.prepare_cached("DELETE FROM sessions WHERE id = ?1")?.execute([session])?;
    Ok(true)
}

/// Applies one small command inside the append transaction: its ack joins `acks`, a row it changed joins `edges`.
fn apply_small(
    tx: &Transaction<'_>,
    cmd: Command,
    env: &SmallEnv<'_>,
    current_labels: &mut PlaceholderLabels,
    refold: &mut bool,
    out: SmallOut<'_>,
) -> rusqlite::Result<()> {
    let SmallEnv { archive, read_seq, watch } = *env;
    let SmallOut { acks, refused, edges } = out;
    match cmd {
        Command::MarkDirty { session, log_id, activation, ack } => {
            let marked = tx.prepare_cached("UPDATE sessions SET dirty = 1 WHERE id = ?1 AND log_id = ?2")?.execute([&session, &log_id])?;
            if marked == 0 {
                refused.push((ack, format!("{session}: the index holds no row of its log {log_id} to mark dirty")));
            } else {
                // The mark is this activation's from here: a retirement of any other no longer clears it.
                tx.prepare_cached("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")?
                    .execute(params![mark_key(&session), activation.to_string()])?;
                acks.push(ack);
            }
        }
        Command::Status { session, status, damage, ack } => {
            set_status_on(tx, &session, status, damage.as_deref())?;
            acks.push(ack);
        }
        Command::Delete { session, ack } => {
            tx.prepare_cached("UPDATE sessions SET deleted = 1, dirty = 0 WHERE id = ?1")?.execute([&session])?;
            acks.push(ack);
        }
        Command::Labels { labels, ack } => {
            let json = serde_json::to_string(&[&labels.image, &labels.video, &labels.file]).expect("labels encode");
            let mut meta = tx.prepare_cached("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")?;
            meta.execute([LABELS_KEY, json.as_str()])?;
            meta.execute([REFOLD_JOB, "0"])?;
            *current_labels = labels;
            *refold = true;
            acks.push(ack);
        }
        Command::OffloadScan { session, ordinal, sources, ack } => {
            record_offload_scan(tx, &session, ordinal, &sources)?;
            acks.push(ack);
        }
        Command::Arrived { session, log_id, base_session, ack } => {
            tx.prepare_cached("UPDATE sessions SET log_id = ?2, base_session = ?3, dirty = 1 WHERE id = ?1 AND log_id = ?4")?.execute(params![
                session,
                log_id,
                base_session,
                PENDING_LOG_ID
            ])?;
            acks.push(ack);
        }
        Command::Pending { sessions, ack } => {
            // One transaction for them all: they are listed once, before the first client reads the list.
            for (head, stats) in &sessions {
                // A row there is (taken in already, or listed by an earlier start) is left as it is.
                if !tx.prepare_cached("SELECT 1 FROM sessions WHERE id = ?1")?.exists([&head.session])? {
                    let mut row = crate::summary::catalog_row(head, stats, now_ms());
                    resolve_archive(&mut row, archive);
                    write_row(tx, &row, DirtyMark::Clear, current_labels)?;
                }
            }
            acks.push(ack);
        }
        Command::Archive { sessions, read, ack } => {
            read.store(read_seq, std::sync::atomic::Ordering::SeqCst);
            for session in &sessions {
                let Some(entry) = archive.and_then(|archive| archive.entry(session)) else { continue };
                let archived_at = entry.archived_at();
                let before = stored_row(tx, session)?;
                let changed = tx
                    .prepare_cached("UPDATE sessions SET archived = ?2, archived_at = ?3 WHERE id = ?1 AND (archived <> ?2 OR archived_at IS NOT ?3)")?
                    .execute(params![session, archived_at.is_some(), archived_at])?;
                if let Some(mut before) = before.filter(|before| watch && changed > 0 && before.archived != archived_at.is_some()) {
                    // The row of a session owing its sensitive rewrite is told without its content.
                    if withheld::is_withheld_in(tx, session)? {
                        before.summary = withheld::blank_summary(&before.summary);
                        before.user_name = None;
                    }
                    let after = StoredRow { archived: archived_at.is_some(), ..before.clone() };
                    edges.push(RowEdge { id: session.clone(), before: Some(before), after });
                }
            }
            acks.push(ack);
        }
        Command::Withhold { sessions, ack } => {
            Writer::withhold_on(tx, &sessions)?;
            acks.push(ack);
        }
        Command::Release { session, ack } => {
            edges.extend(Writer::release_on(tx, &session, watch)?);
            acks.push(ack);
        }
        #[cfg(any(test, feature = "test-support"))]
        Command::ForgetThreadOp { session, op_id, ack } => {
            if tx.prepare_cached("DELETE FROM thread_ops WHERE session = ?1 AND op_id = ?2")?.execute([&session, &op_id])? == 0 {
                refused.push((ack, format!("{session}: the index holds no row of the op {op_id}")));
            } else {
                acks.push(ack);
            }
        }
        Command::Close => unreachable!("the writer stops before it queues a close"),
        Command::Upsert { .. } | Command::Project { .. } | Command::Retire { .. } | Command::Purge { .. } | Command::Repair { .. } => {
            unreachable!("queued separately")
        }
    }
    Ok(())
}

/// A catalog row to write: its head, the dirty mark, the acks to answer, and the arrival
/// order of the head.
type Upsert = (Arc<CatalogHead>, DirtyMark, Vec<Ack>, u64);

struct Writer {
    conn: Connection,
    labels: PlaceholderLabels,
    upserts: HashMap<String, Upsert>,
    small: VecDeque<Command>,
    projections: VecDeque<Pending>,
    refold: bool,
    /// Sessions whose row waits for an inherited state still being computed, with the head
    /// the row is to be built from and its arrival order.
    waiting: HashMap<String, (Arc<CatalogHead>, u64)>,
    /// Pending fork views may need a maintenance step.
    views: bool,
    /// Deleted sessions whose rows go in maintenance steps, oldest request first.
    purges: VecDeque<(String, Ack)>,
    /// The retirements whose frames are in, by session, until the row is written.
    retires: HashMap<String, Retiring>,
    /// The repairs' work taken and not yet done, in arrival order ([`Self::repair_step`]).
    repairs: VecDeque<(RepairWork, RepairAck)>,
    /// The row a listing may have answered of each session whose rows a repair is replacing: what its complete row is told
    /// as a change from.
    replaced: HashMap<String, Option<StoredRow>>,
    /// Where the repairs' work is taken first, once the store's gate is there ([`gate::Ranks`]).
    ranks: Arc<std::sync::OnceLock<gate::Ranks>>,
    /// Which kind of work behind the serving core's took the last transaction ([`Self::dispatch`]).
    turn: usize,
    /// The data dir, for the seams of a test ([`reconcile_seam`]).
    #[cfg(test)]
    seam: Option<PathBuf>,
    seq: u64,
    /// Rows per append transaction and per maintenance step (tests shrink them).
    append_rows: usize,
    step_rows: usize,
    /// Told of the rows an append transaction changed, once it committed.
    sink: RowSinkCell,
    /// The archive authority every row written resolves through.
    archive: ArchiveCell,
    /// Moves each time a transaction reads the archive snapshot: the sequence an archive projection read its state at.
    archive_reads: Arc<std::sync::atomic::AtomicU64>,
    /// The answers of the last append transaction, sent once [`Self::run`] took what arrived before them.
    answers: Vec<(Ack, Result<(), DbError>)>,
}

const LABELS_KEY: &str = "ui:placeholder_labels";
const REFOLD_JOB: &str = "job:refold_titles";

/// A test's hold on the repair a start owes one session: this crate's tests, and those of a crate that composes over the
/// index and needs a start whose projection has not ended.
#[cfg(any(test, feature = "test-support"))]
pub mod repair_hold {
    use std::path::Path;
    use std::path::PathBuf;
    use std::sync::Mutex;

    type Held = (PathBuf, String, std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
    static HELD: Mutex<Option<Held>> = Mutex::new(None);

    /// The repair of `session` in `data` starts once the returned sender sends (or is dropped); the receiver is told when
    /// the repairs got to it and wait there.
    pub fn hold(data: &Path, session: &str) -> (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>) {
        let (release, held) = std::sync::mpsc::channel();
        let (arrive, arrived) = std::sync::mpsc::channel();
        *HELD.lock().expect("seam") = Some((data.to_path_buf(), session.to_owned(), arrive, held));
        (release, arrived)
    }

    pub(super) fn wait_if_held(data: &Path, session: &str) {
        let mut slot = HELD.lock().expect("seam");
        if slot.as_ref().is_some_and(|(at, of, ..)| at == data && of == session) {
            let (_, _, arrive, held) = slot.take().expect("held");
            drop(slot);
            let _ = arrive.send(());
            let _ = held.recv();
        }
    }
}

/// The seam of the boot reconcile between a session's projection and its row: a test arms it
/// for one data dir, and the next reconcile there ends (as a process ending at that point).
#[cfg(test)]
pub(crate) mod reconcile_seam {
    use std::path::Path;
    use std::path::PathBuf;
    use std::sync::Mutex;

    static ARMED: Mutex<Option<PathBuf>> = Mutex::new(None);
    static FAILING: Mutex<Option<PathBuf>> = Mutex::new(None);
    type Held = (PathBuf, String, std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
    pub(crate) use super::repair_hold::hold;

    pub(crate) fn arm(data: &Path) {
        *ARMED.lock().expect("seam") = Some(data.to_path_buf());
    }

    /// Whether the seam [`arm`] set for `data` has not been reached yet.
    pub(crate) fn armed(data: &Path) -> bool {
        ARMED.lock().expect("seam").as_deref() == Some(data)
    }

    /// The next reconcile in `data` fails its first index write.
    pub(crate) fn fail(data: &Path) {
        *FAILING.lock().expect("seam") = Some(data.to_path_buf());
    }

    pub(super) fn fails_here(data: &Path) -> bool {
        let mut failing = FAILING.lock().expect("seam");
        let hit = failing.as_deref() == Some(data);
        if hit {
            *failing = None;
        }
        hit
    }

    type Rebuild = (PathBuf, std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
    static REBUILD: Mutex<Option<Rebuild>> = Mutex::new(None);

    /// The next rebuild of a session's rows in `data` stops between its purge and its replay until the returned sender
    /// sends (or is dropped); the receiver is told when it got there.
    pub(crate) fn hold_rebuild(data: &Path) -> (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>) {
        let (release, held) = std::sync::mpsc::channel();
        let (arrive, arrived) = std::sync::mpsc::channel();
        *REBUILD.lock().expect("seam") = Some((data.to_path_buf(), arrive, held));
        (release, arrived)
    }

    pub(super) fn wait_in_rebuild(data: &Path) {
        let mut slot = REBUILD.lock().expect("seam");
        if slot.as_ref().is_some_and(|(at, ..)| at == data) {
            let (_, arrive, held) = slot.take().expect("held");
            drop(slot);
            let _ = arrive.send(());
            let _ = held.recv();
        }
    }

    pub(super) fn ends_here(data: &Path) -> bool {
        let mut armed = ARMED.lock().expect("seam");
        let hit = armed.as_deref() == Some(data);
        if hit {
            *armed = None;
        }
        hit
    }

    static FAILING_OF: Mutex<Vec<(PathBuf, String)>> = Mutex::new(Vec::new());

    /// The next repair of `session` in `data` fails its first index write.
    pub(crate) fn fail_session(data: &Path, session: &str) {
        FAILING_OF.lock().expect("seam").push((data.to_path_buf(), session.to_owned()));
    }

    pub(super) fn fails_session(data: &Path, session: &str) -> bool {
        let mut failing = FAILING_OF.lock().expect("seam");
        let at = failing.iter().position(|(at, of)| at == data && of == session);
        at.map(|at| failing.remove(at)).is_some()
    }

    static SLICES: Mutex<Vec<Held>> = Mutex::new(Vec::new());

    /// The writer stops inside the next transaction of `session`'s repair work in `data` (a purge slice, or a part of
    /// its frames) until the returned sender sends (or is dropped); the receiver is told when it got there.
    pub(crate) fn hold_slice(data: &Path, session: &str) -> (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>) {
        let (release, held) = std::sync::mpsc::channel();
        let (arrive, arrived) = std::sync::mpsc::channel();
        SLICES.lock().expect("seam").push((data.to_path_buf(), session.to_owned(), arrive, held));
        (release, arrived)
    }

    pub(super) fn wait_in_slice(data: &Path, session: &str) {
        let mut slots = SLICES.lock().expect("seam");
        if let Some(at) = slots.iter().position(|(at, of, ..)| at == data && of == session) {
            let (_, _, arrive, held) = slots.remove(at);
            drop(slots);
            let _ = arrive.send(());
            let _ = held.recv();
        }
    }

    static SETTLES: Mutex<Vec<Held>> = Mutex::new(Vec::new());

    /// The repair of `session` in `data` stops once its last transaction committed and before its outcome is settled
    /// (no waiter woken, no progress told) until the returned sender sends (or is dropped); the receiver is told when
    /// it got there.
    pub(crate) fn hold_settle(data: &Path, session: &str) -> (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>) {
        let (release, held) = std::sync::mpsc::channel();
        let (arrive, arrived) = std::sync::mpsc::channel();
        SETTLES.lock().expect("seam").push((data.to_path_buf(), session.to_owned(), arrive, held));
        (release, arrived)
    }

    pub(super) fn wait_before_settle(data: &Path, session: &str) {
        let mut slots = SETTLES.lock().expect("seam");
        if let Some(at) = slots.iter().position(|(at, of, ..)| at == data && of == session) {
            let (_, _, arrive, held) = slots.remove(at);
            drop(slots);
            let _ = arrive.send(());
            let _ = held.recv();
        }
    }

    /// One transaction the writer committed: what it was of (`serving`, or a repair's `purge`, `whole`, `part`,
    /// `finish`), the session of a repair's, and the rows it took of its budget.
    pub(crate) type Commit = (&'static str, String, usize);
    static COMMITS: Mutex<Vec<(PathBuf, Commit)>> = Mutex::new(Vec::new());

    pub(super) fn committed(data: &Path, kind: &'static str, session: &str, rows: usize) {
        COMMITS.lock().expect("seam").push((data.to_path_buf(), (kind, session.to_owned(), rows)));
    }

    /// Where an append transaction fails, as the database failing there.
    #[derive(PartialEq)]
    pub(crate) enum AppendFault {
        Begin,
        /// The frames of this session's projection.
        Frames(String),
        /// The catalog row the transaction writes at this place among its rows (0: the first).
        RowAt(usize),
        Commit,
    }
    static APPEND_FAULTS: Mutex<Vec<(PathBuf, AppendFault)>> = Mutex::new(Vec::new());
    pub(super) const INJECTED: &str = "the test's injected append failure";

    /// The next append transaction of `data` that gets to `fault` fails there.
    pub(crate) fn fail_append(data: &Path, fault: AppendFault) {
        APPEND_FAULTS.lock().expect("seam").push((data.to_path_buf(), fault));
    }

    pub(super) fn append_fault(data: &Option<PathBuf>, fault: AppendFault) -> rusqlite::Result<()> {
        let Some(data) = data else { return Ok(()) };
        let mut faults = APPEND_FAULTS.lock().expect("seam");
        match faults.iter().position(|(at, armed)| at == data && *armed == fault) {
            Some(at) => {
                faults.remove(at);
                Err(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL), Some(INJECTED.to_owned())))
            }
            None => Ok(()),
        }
    }

    /// The transactions the writer of `data` committed, in order (and `locked`: an append transaction that did not begin
    /// for a foreign connection's lock).
    pub(crate) fn commits(data: &Path) -> Vec<Commit> {
        COMMITS.lock().expect("seam").iter().filter(|(at, _)| at == data).map(|(_, commit)| commit.clone()).collect()
    }
}

/// The row of `session` a listing reads, as the connection's transaction holds it.
fn stored_row(c: &Connection, session: &str) -> rusqlite::Result<Option<StoredRow>> {
    c.prepare_cached("SELECT summary, archived, deleted, user_name FROM sessions WHERE id = ?1")?
        .query_row([session], |r| Ok(StoredRow { summary: r.get(0)?, archived: r.get(1)?, deleted: r.get(2)?, user_name: r.get(3)? }))
        .optional()
}

/// Commits `tx`, the row sink told of the row change `edge` around the commit as an append transaction tells its own.
fn commit_told(sink: &RowSinkCell, tx: Transaction<'_>, edge: Option<RowEdge>) -> rusqlite::Result<()> {
    let sink = sink.get().filter(|_| edge.is_some());
    if let Some(sink) = sink {
        sink.writing(1);
    }
    let committed = tx.commit();
    match (sink, edge) {
        (Some(sink), Some(edge)) if committed.is_ok() => sink.written(edge),
        (Some(sink), _) => sink.dropped(1),
        _ => {}
    }
    committed
}

impl Writer {
    fn start(path: &Path) -> Result<Writer, DbError> {
        let conn = open_writer(path, None)?;
        let stored: Option<String> = conn.query_row("SELECT value FROM meta WHERE key = ?1", [LABELS_KEY], |r| r.get(0)).optional()?;
        let labels = match stored {
            Some(json) => {
                let [image, video, file]: [String; 3] = serde_json::from_str(&json).map_err(|e| DbError::Rebuild(e.to_string()))?;
                PlaceholderLabels { image, video, file }
            }
            None => PlaceholderLabels::default(),
        };
        let refold: bool = conn.query_row("SELECT 1 FROM meta WHERE key = ?1", [REFOLD_JOB], |_| Ok(())).optional()?.is_some();
        let views: bool = conn.query_row("SELECT 1 FROM message_views WHERE state = 'pending' LIMIT 1", [], |_| Ok(())).optional()?.is_some();
        Ok(Writer {
            conn,
            labels,
            upserts: HashMap::new(),
            small: VecDeque::new(),
            projections: VecDeque::new(),
            refold,
            waiting: HashMap::new(),
            views,
            purges: VecDeque::new(),
            retires: HashMap::new(),
            repairs: VecDeque::new(),
            replaced: HashMap::new(),
            ranks: Arc::default(),
            turn: 0,
            #[cfg(test)]
            seam: None,
            seq: 0,
            archive_reads: Arc::default(),
            append_rows: APPEND_ROWS,
            step_rows: STEP_ROWS,
            sink: RowSinkCell::default(),
            archive: ArchiveCell::default(),
            answers: Vec::new(),
        })
    }

    fn answer(&mut self) {
        for (ack, answer) in self.answers.drain(..) {
            let _ = ack.send(answer);
        }
    }

    /// [`Self::append_transaction`] answered at once, as [`Self::run`] answers it before its next decision: a test that
    /// drives the writer a transaction at a time.
    #[cfg(test)]
    fn append_answered(&mut self) {
        self.append_transaction();
        self.answer();
    }

    fn take(&mut self, cmd: Command) {
        self.seq += 1;
        let seq = self.seq;
        match cmd {
            // Queued behind what the serving core writes ([`Self::dispatch`]): every request that names its session waits at
            // the gate until that session's repair is done, so nothing else reads its rows meanwhile.
            Command::Repair { work, ack } => self.repairs.push_back((work, ack)),
            Command::Upsert { head, dirty, ack } => {
                let entry = self.upserts.entry(head.session.clone()).or_insert_with(|| (head.clone(), dirty, Vec::new(), seq));
                // Coalesce: newest fields; a Set/Clear outranks an earlier Keep.
                entry.0 = head;
                entry.3 = seq;
                if dirty != DirtyMark::Keep {
                    entry.1 = dirty;
                }
                entry.2.extend(ack);
            }
            Command::Project { projection, ack } => {
                self.projections.push_back(Pending { projection, next: 0, ack, seq, retire: None, hole: None });
            }
            Command::Retire { projection, retirement, ack } => {
                self.projections.push_back(Pending { projection, next: 0, ack: Some(ack), seq, retire: Some(retirement), hole: None });
            }
            Command::Purge { session, ack } => self.purges.push_back((session, ack)),
            other => self.small.push_back(other),
        }
    }

    /// Whether the serving core has a write queued: it goes before any work behind it.
    fn serving_queued(&self) -> bool {
        !(self.upserts.is_empty() && self.small.is_empty() && self.projections.is_empty())
    }

    fn idle(&self) -> bool {
        self.repairs.is_empty() && !self.serving_queued() && !self.refold && !self.views && self.purges.is_empty()
    }

    /// One transaction of the repairs' work: the best-ranked piece (a requested session's and what it needs first, then a
    /// worker candidate's, then the rest of a rebuild; oldest first among equals), one step of it. A piece that is not
    /// done goes back where it was. A failure is answered to that piece's sender alone: the others stay queued.
    fn repair_step(&mut self) {
        let at = match self.ranks.get() {
            Some(ranks) => (0..self.repairs.len()).min_by_key(|&at| ranks.of(self.repairs[at].0.session())).unwrap_or(0),
            None => 0,
        };
        let Some((work, ack)) = self.repairs.remove(at) else { return };
        match work {
            RepairWork::Purge { session, started } => self.replay_purge(session, started, ack, at),
            RepairWork::Replay(replay) if replay.whole() => self.replay_whole(replay, ack, at),
            RepairWork::Replay(replay) => self.replay_part(replay, ack, at),
            RepairWork::Finish(finish) => self.replay_finish(finish, ack, at),
            RepairWork::Forget { session } => {
                let _ = ack.send(clear_debt(&self.conn, &session).map_err(|e| DbError::Write(e.to_string())));
            }
        }
    }

    /// A piece of work not done yet, back where it was taken from.
    fn requeue(&mut self, at: usize, work: RepairWork, ack: mpsc::Sender<Result<(), DbError>>) {
        self.repairs.insert(at.min(self.repairs.len()), (work, ack));
    }

    /// One transaction of a commit trace a test reads ([`reconcile_seam::commits`]).
    #[cfg(test)]
    fn trace(&self, kind: &'static str, session: &str, rows: usize) {
        if let Some(data) = &self.seam {
            reconcile_seam::committed(data, kind, session, rows);
        }
    }

    /// One slice of [`RepairWork::Purge`]. The first records the hole before any row goes, in the same transaction, and
    /// keeps the row a listing may have answered.
    fn replay_purge(&mut self, session: String, started: bool, ack: mpsc::Sender<Result<(), DbError>>, at: usize) {
        let step_rows = self.step_rows;
        let step = (|| -> rusqlite::Result<(bool, Option<Option<StoredRow>>)> {
            let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            #[cfg(test)]
            if let Some(data) = &self.seam {
                reconcile_seam::wait_in_slice(data, &session);
            }
            let mut replaced = None;
            if !started {
                tx.prepare_cached("INSERT INTO meta (key, value) VALUES (?1, '1') ON CONFLICT(key) DO NOTHING")?.execute([hole_key(&session)])?;
                replaced = Some(stored_row(&tx, &session)?);
            }
            let done = purge_slice(&tx, &session, true, step_rows)?;
            tx.commit()?;
            Ok((done, replaced))
        })();
        match step {
            Ok((done, replaced)) => {
                #[cfg(test)]
                self.trace("purge", &session, step_rows);
                if let Some(replaced) = replaced {
                    self.replaced.insert(session.clone(), replaced);
                }
                if done {
                    let _ = ack.send(Ok(()));
                } else {
                    self.requeue(at, RepairWork::Purge { session, started: true }, ack);
                }
            }
            Err(e) => {
                let _ = ack.send(Err(DbError::Write(e.to_string())));
            }
        }
    }

    /// One transaction of sessions read whole: `first`, then each whole session queued behind it while it fits what is
    /// left of the budget. Each is a savepoint; one that fails is undone and answered with its own failure. A session that
    /// does not fit an empty transaction is not committed at all here: it goes on part by part ([`Self::replay_part`]).
    fn replay_whole(&mut self, first: Box<Replay>, ack: mpsc::Sender<Result<(), DbError>>, at: usize) {
        let watch = self.sink.get().is_some();
        let archive = bound_archive(&self.archive);
        let mut applied: Vec<(String, RepairAck)> = Vec::new();
        let mut refused: Vec<(RepairAck, String)> = Vec::new();
        // What goes back to the queue, in its order: a session that waits for the next transaction, or goes on in parts.
        let mut back: Vec<(Box<Replay>, RepairAck)> = Vec::new();
        let mut edges: Vec<RowEdge> = Vec::new();
        let mut told = 0usize;
        let mut budget = Budget::new(self.append_rows);
        let (conn, queue, labels, sink) = (&mut self.conn, &mut self.repairs, &self.labels, &self.sink);
        let result = (|| -> rusqlite::Result<()> {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let mut next = Some((first, ack));
            while let Some((mut replay, ack)) = next.take() {
                let finish = replay.finish.take().expect("a whole session carries its row");
                tx.execute_batch("SAVEPOINT whole")?;
                let mut changed = Vec::new();
                let mut left = budget;
                let env = WholeEnv { labels, watch, archive: archive.as_deref() };
                let fits = whole_on(&tx, &replay, &finish, env, &mut changed, &mut left);
                replay.finish = Some(finish);
                match fits {
                    Ok(true) => {
                        tx.execute_batch("RELEASE whole")?;
                        budget = left;
                        edges.extend(changed);
                        applied.push((replay.session.clone(), ack));
                    }
                    Ok(false) => {
                        tx.execute_batch("ROLLBACK TO whole; RELEASE whole")?;
                        // Larger than a whole transaction: from here it is applied in parts.
                        replay.split = budget.fresh();
                        back.push((replay, ack));
                        break;
                    }
                    Err(e) => {
                        tx.execute_batch("ROLLBACK TO whole; RELEASE whole")?;
                        refused.push((ack, format!("{}: {e}", replay.session)));
                    }
                }
                // The next whole session queued, while room is left for the smallest.
                if budget.rows > ROW_ROOM
                    && let Some(at) = queue.iter().position(|(work, _)| matches!(work, RepairWork::Replay(replay) if replay.whole()))
                    && let Some((RepairWork::Replay(replay), ack)) = queue.remove(at)
                {
                    next = Some((replay, ack));
                }
            }
            if let Some(sink) = sink.get().filter(|_| !edges.is_empty()) {
                sink.writing(edges.len());
                told = edges.len();
            }
            tx.commit()
        })();
        for (replay, ack) in back.into_iter().rev() {
            self.requeue(at, RepairWork::Replay(replay), ack);
        }
        for (ack, why) in refused {
            let _ = ack.send(Err(DbError::Write(why)));
        }
        match result {
            Ok(()) => {
                #[cfg(test)]
                self.trace("whole", applied.first().map_or("", |(session, _)| session.as_str()), budget.used());
                if let Some(sink) = self.sink.get() {
                    for edge in edges {
                        sink.written(edge);
                    }
                }
                // A fork of one of these may now have a view to finish.
                self.views |= !applied.is_empty();
                for (_, ack) in applied {
                    let _ = ack.send(Ok(()));
                }
            }
            Err(e) => {
                if told > 0
                    && let Some(sink) = self.sink.get()
                {
                    sink.dropped(told);
                }
                // The transaction's own failure is that of the sessions it held, and of no other: what is queued stays so.
                for (_, ack) in applied {
                    let _ = ack.send(Err(DbError::Write(e.to_string())));
                }
            }
        }
    }

    /// One transaction of a session applied in parts: with the first, its hole (a session a rebuild owes is rebuilt from
    /// its log by any start that finds it between here and its complete row) and its row, dirty; then frames while the
    /// budget has room. With the last frame in, its folded row is the next piece of work.
    fn replay_part(&mut self, mut replay: Box<Replay>, ack: mpsc::Sender<Result<(), DbError>>, at: usize) {
        let archive = bound_archive(&self.archive);
        let mut budget = Budget::new(self.append_rows);
        let (mut next, mut part) = (replay.next, replay.part);
        let (conn, labels) = (&mut self.conn, &self.labels);
        #[cfg(test)]
        let seam = &self.seam;
        let step = (|| -> rusqlite::Result<(bool, Option<Option<StoredRow>>)> {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            #[cfg(test)]
            if let Some(data) = seam {
                reconcile_seam::wait_in_slice(data, &replay.session);
            }
            if !replay.partial {
                budget.reserve(1);
                tx.prepare_cached("INSERT OR IGNORE INTO meta (key, value) SELECT ?1, '' WHERE EXISTS (SELECT 1 FROM meta WHERE key = ?2)")?
                    .execute([hole_key(&replay.session), rebuild_key(&replay.session)])?;
            }
            let mut before = None;
            if let Some(start) = &replay.start {
                budget.reserve(1);
                before = Some(stored_row(&tx, &replay.session)?);
                upsert(&tx, start, DirtyMark::Set, labels, archive.as_deref())?;
            }
            let done = apply_frames(&tx, &replay.frames_session, &replay.frames, &mut next, &mut part, &mut budget)?;
            tx.commit()?;
            Ok((done, before))
        })();
        match step {
            Ok((done, before)) => {
                #[cfg(test)]
                self.trace("part", &replay.session, budget.used());
                if let Some(before) = before {
                    self.replaced.entry(replay.session.clone()).or_insert(before);
                }
                (replay.partial, replay.start, replay.next, replay.part) = (true, None, next, part);
                match (done, replay.finish.take()) {
                    (false, finish) => {
                        replay.finish = finish;
                        self.requeue(at, RepairWork::Replay(replay), ack);
                    }
                    (true, Some(finish)) => self.requeue(at, RepairWork::Finish(Box::new(finish)), ack),
                    (true, None) => {
                        let _ = ack.send(Ok(()));
                    }
                }
            }
            Err(e) => {
                let _ = ack.send(Err(DbError::Write(format!("{}: {e}", replay.session))));
            }
        }
    }

    /// One transaction of a session's folded row. The row, its damage and the end of its debt (hole, rebuild, and with a
    /// clean row its mark) are one transaction: the session stops being one a start repairs exactly when its complete
    /// projection is readable. A fork whose row waits for its view has that view computed first, a step a dispatch, its
    /// debt kept meanwhile; a view no step can compute fails the repair, with the debt left for the next start.
    fn replay_finish(&mut self, mut finish: Box<Finish>, ack: mpsc::Sender<Result<(), DbError>>, at: usize) {
        if finish.viewing {
            self.view_step();
            if !self.waiting.contains_key(&finish.session) {
                finish.viewing = false;
            } else if !self.views {
                self.waiting.remove(&finish.session);
                self.finish_unviewed(&finish, ack);
                return;
            }
            self.requeue(at, RepairWork::Finish(finish), ack);
            return;
        }
        let archive = bound_archive(&self.archive);
        let session = finish.session.as_str();
        let before = self.replaced.get(session).cloned();
        let (conn, labels, sink) = (&mut self.conn, &self.labels, &self.sink);
        // `Ok(None)`: the row waits for its view.
        let step = (|| -> rusqlite::Result<Option<bool>> {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            // A listing may have answered the row from before the repair: the sink is told of the change, as of any other
            // row write. A session of the withheld set is told by its release, from the blank row.
            let watch = finish.recovery && sink.get().is_some() && !withheld::is_withheld_in(&tx, session)?;
            let (written, edge) = upsert_edge(&tx, &finish.head, finish.dirty, labels, watch, archive.as_deref())?;
            if written == 0 && finish.recovery {
                return Ok(None);
            }
            // The row left after a purge is told whatever it equals: a list read after the purge saw no row of the session.
            let edge = match before {
                Some(before) if watch && written > 0 => stored_row(&tx, session)?.map(|after| RowEdge { id: session.to_owned(), before, after }),
                _ => edge,
            };
            if let Some(damage) = &finish.damage {
                set_status_on(&tx, session, SessionStatus::Damaged, Some(damage))?;
            }
            clear_debt(&tx, session)?;
            if finish.dirty == DirtyMark::Clear {
                tx.prepare_cached("DELETE FROM meta WHERE key = ?1")?.execute([mark_key(session)])?;
            }
            commit_told(sink, tx, edge)?;
            Ok(Some(written > 0))
        })();
        match step {
            Ok(Some(_)) => {
                #[cfg(test)]
                self.trace("finish", session, ROW_ROOM);
                self.replaced.remove(session);
                // A fork whose base gained rows may now have a view to finish.
                self.views = true;
                let truncated = if finish.replaced { truncate_wal(&self.conn).map_err(DbError::Write) } else { Ok(()) };
                let _ = ack.send(truncated);
            }
            Ok(None) => {
                let runnable = (|| -> rusqlite::Result<bool> {
                    let tx = self.conn.transaction()?;
                    crate::message_index::view_runnable(&tx, session)
                })();
                match runnable {
                    Ok(true) => {
                        self.seq += 1;
                        self.waiting.insert(session.to_owned(), (Arc::new(finish.head.clone()), self.seq));
                        self.views = true;
                        finish.viewing = true;
                        self.requeue(at, RepairWork::Finish(finish), ack);
                    }
                    Ok(false) => self.finish_unviewed(&finish, ack),
                    Err(e) => {
                        self.replaced.remove(session);
                        let _ = ack.send(Err(DbError::Write(format!("{session}: {e}"))));
                    }
                }
            }
            Err(e) => {
                self.replaced.remove(session);
                let _ = ack.send(Err(DbError::Write(format!("{session}: {e}"))));
            }
        }
    }

    /// The end of a fork's repair whose view no step can compute. A fork is repaired after its base, so the base is
    /// settled here and its rows stop short of the fork point for good, as those of a base damaged below it do: that is
    /// the base's state, recorded on the base, and no failure of the fork's own projection. The fork keeps the row its
    /// own frames gave it, as a reconcile always left such a fork, with its damage; its hole and its rebuild debt go,
    /// every frame of its own log being in. Its row stays marked, so the next start tries the view again.
    fn finish_unviewed(&mut self, finish: &Finish, ack: mpsc::Sender<Result<(), DbError>>) {
        let session = finish.session.as_str();
        self.replaced.remove(session);
        let step = (|| -> rusqlite::Result<()> {
            let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            if let Some(damage) = &finish.damage {
                set_status_on(&tx, session, SessionStatus::Damaged, Some(damage))?;
            }
            clear_debt(&tx, session)?;
            tx.commit()
        })();
        #[cfg(test)]
        if step.is_ok() {
            self.trace("finish", session, ROW_ROOM);
        }
        let _ = ack.send(step.map_err(|e| DbError::Write(format!("{session}: {e}"))));
    }

    /// The rows of `rewrite`'s session rebuilt from its log before the store serves: the boot's own step, on the
    /// connection no writer thread runs yet, so it has no queue to give way to and applies its transactions in a row.
    /// The serving store rebuilds a session's rows as [`RepairWork`], a transaction a dispatch.
    fn reproject_before_serving(&mut self, rewrite: &Rewritten) -> Result<(), String> {
        let Rewritten { data, session, dirty } = rewrite;
        let (data, session, dirty) = (data.as_path(), session.as_str(), *dirty);
        let labels = self.labels.clone();
        let rows = (|| -> Result<(), String> {
            self.conn.execute("INSERT INTO meta (key, value) VALUES (?1, '1') ON CONFLICT(key) DO NOTHING", [hole_key(session)]).map_err(|e| e.to_string())?;
            // The fork edge stays: a fork under rebuild still reads its base, which no purge may take meanwhile.
            while !self.purge_rows(session, true).map_err(|e| e.to_string())? {}
            let dir = data.join("sessions").join(session);
            let mut fold = None;
            let damage = project_session(&mut self.conn, &dir, &crate::blobs::BlobStore::new(data), &mut fold, None)?
                .err()
                .map(|(error, at)| damage_text(&dir, at, &error));
            let head = fold.as_ref().map_or_else(|| unreadable_head(session), CatalogHead::of);
            let archive = bound_archive(&self.archive);
            let tx = self.conn.transaction().map_err(|e| e.to_string())?;
            upsert(&tx, &head, dirty, &labels, archive.as_deref()).map_err(|e| e.to_string())?;
            if let Some(damage) = damage {
                set_status_on(&tx, session, SessionStatus::Damaged, Some(&damage)).map_err(|e| e.to_string())?;
            }
            // The rows are the log's again, whatever projection of it was missed before: only here, with the complete row,
            // does the session stop being one a start has to repair ([`owed_repairs`]).
            clear_debt(&tx, session).map_err(|e| e.to_string())?;
            if dirty == DirtyMark::Clear {
                tx.execute("DELETE FROM meta WHERE key = ?1", [mark_key(session)]).map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())
        })();
        // A fork view over these rows settles in the maintenance steps.
        self.views = true;
        rows.and_then(|()| truncate_wal(&self.conn))
    }

    /// One bounded step of purging `session`'s index rows ([`purge_slice`]), in a transaction of its own.
    fn purge_rows(&mut self, session: &str, keep_edge: bool) -> rusqlite::Result<bool> {
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let done = purge_slice(&tx, session, keep_edge, self.step_rows)?;
        tx.commit()?;
        Ok(done)
    }

    fn boot_purge(&mut self, lane: &InLane<MaintenanceIo>, data: &Path, incomplete: &[String]) -> Result<(), DbError> {
        for session in incomplete {
            while !self.purge_rows(session, false)? {}
            forget_keys(&self.conn, session)?;
        }
        // A fork's edge is in the index only once its first frame is: while a session's projection is owed (a repair, a rebuild
        // cut off), a missing edge is no proof that no fork reads a deleted session's log, so nothing is purged.
        if !owed_repairs(&self.conn)?.is_empty() {
            return Ok(());
        }
        loop {
            let next = self.conn.prepare_cached(PURGEABLE_SQL)?.query_row([], |r| r.get::<_, String>(0)).optional()?;
            let Some(session) = next else { return Ok(()) };
            remove_session_dir(lane, &data.join("sessions").join(&session))?;
            while !self.purge_rows(&session, false)? {}
            forget_keys(&self.conn, &session)?;
        }
    }

    #[allow(clippy::disallowed_methods, reason = "runs on the maintenance lane job (lane proof argument)")]
    fn boot(lane: &InLane<MaintenanceIo>, data: &Path, path: &Path, steps: &mut Vec<(&'static str, Instant)>) -> Result<Writer, DbError> {
        let blobs = crate::blobs::BlobStore::new(data);
        let rewritten = crate::log_rewrite::recover(lane, data, &crate::log::OsIo, &blobs).map_err(|e| DbError::Write(e.to_string()))?;
        steps.push(("rewrites-recovered", Instant::now()));
        // An index the upgrade cannot read or write is the rebuild's, as any other it cannot open.
        // Each step in turn: an index of version 18 takes them all.
        let steps_taken = upgrade_from_18(data, path).and_then(|from_18| Ok(upgrade_from_19(path)? || from_18));
        match steps_taken.and_then(|earlier| Ok(upgrade_from_20(path)? || earlier)) {
            Ok(true) => steps.push(("upgraded-in-place", Instant::now())),
            Ok(false) => {}
            Err(_) => steps.push(("in-place-upgrade-refused", Instant::now())),
        }
        let existing = match path.exists().then(|| Writer::start(path)) {
            Some(Ok(writer)) => Some(writer),
            Some(Err(e)) if !needs_rebuild(&e) => return Err(e),
            _ => None,
        };
        steps.push(("writer-opened", Instant::now()));
        let (incomplete, complete) = scan_session_dirs(lane, &data.join("sessions"), existing.is_none())?;
        steps.push(("session-dirs-scanned", Instant::now()));
        let mut writer = match existing {
            Some(writer) => writer,
            None => {
                let first = worker_candidates(path, &complete);
                fresh_index(lane, data, path, &complete, first.as_ref())?;
                Writer::start(path).map_err(|e| match e {
                    DbError::Rebuild(why) => DbError::Write(format!("rebuilt index refused: {why}")),
                    e => e,
                })?
            }
        };
        steps.push(("rebuilt", Instant::now()));
        writer.boot_purge(lane, data, &incomplete)?;
        steps.push(("purged", Instant::now()));
        for session in rewritten {
            crate::log_rewrite::finish(lane, data, &session, &mut || {
                let rewrite = Rewritten { data: data.to_path_buf(), session: session.clone(), dirty: DirtyMark::Clear };
                writer.reproject_before_serving(&rewrite)
            })
            .map_err(|e| DbError::Write(e.to_string()))?;
        }
        #[cfg(test)]
        {
            writer.seam = Some(data.to_path_buf());
        }
        Ok(writer)
    }

    /// One bounded step of the oldest purge (`purge_rows`).
    fn purge_step(&mut self) {
        let Some((session, _)) = self.purges.front() else { return };
        let session = session.clone();
        let step = self.purge_rows(&session, false);
        match step {
            Ok(false) => {}
            Ok(true) => {
                let (session, ack) = self.purges.pop_front().expect("front");
                let _ = ack.send(forget_keys(&self.conn, &session).map_err(|e| DbError::Write(e.to_string())));
            }
            Err(e) => {
                let (_, ack) = self.purges.pop_front().expect("front");
                let _ = ack.send(Err(DbError::Write(e.to_string())));
            }
        }
    }

    /// One bounded step of the pending fork views; a finished view rebuilds its row.
    fn view_step(&mut self) {
        let step = (|| -> rusqlite::Result<crate::message_index::Step> {
            let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let step = crate::message_index::view_step(&tx, self.step_rows)?;
            if let crate::message_index::Step::Done(session) = &step
                && !self.waiting.contains_key(session)
            {
                // The head was lost with a restart: the reconcile re-derives the row.
                tx.prepare_cached("UPDATE sessions SET dirty = 1 WHERE id = ?1")?.execute([session])?;
            }
            tx.commit()?;
            Ok(step)
        })();
        match step {
            Ok(crate::message_index::Step::Progress) => {}
            Ok(crate::message_index::Step::Done(session)) => {
                if let Some((head, seq)) = self.waiting.remove(&session) {
                    // A newer head queued meanwhile wins. The head keeps its arrival order, so a projection of the session
                    // queued after it (whose head is newer) still replaces it, and does not hold its row back.
                    self.upserts.entry(session).or_insert_with(|| (head, DirtyMark::Keep, Vec::new(), seq));
                }
            }
            // Idle, or failed: new work re-arms it.
            Ok(crate::message_index::Step::Idle) => {
                self.views = false;
                // No view can be advanced: a retirement whose row waits for one is not completed in this process. It is
                // refused now, its mark left.
                self.refuse_waiting_retirements("cannot be computed before the next start");
            }
            // View work stops until new work re-arms it, and no retirement is left waiting on it: each is refused, its
            // mark left, so its unload ends and the session can be opened again.
            Err(e) => {
                self.views = false;
                self.refuse_waiting_retirements(&format!("failed to be computed ({e})"));
            }
        }
    }

    /// Refuses every retirement whose row waits for a fork view, with what became of that view.
    fn refuse_waiting_retirements(&mut self, fate: &str) {
        let stuck: Vec<String> = self.retires.keys().filter(|id| !self.upserts.contains_key(*id) && self.waiting.contains_key(*id)).cloned().collect();
        for session in stuck {
            let retiring = self.retires.remove(&session).expect("listed");
            let why = format!("{session}: its row waits for a fork view that {fate}");
            let _ = retiring.ack.send(Err(DbError::Write(why)));
        }
    }

    /// The answers of an append transaction go out after the drain that follows it: a request sent in reply to one is
    /// taken only after the next transaction is chosen, whichever thread runs first once the answer wakes its sender.
    /// With nothing else queued or due, that next transaction is the first step of what the answered one made due (the
    /// title refold, a fork view); a request another caller had already sent, another due step, or a later step of the
    /// same work can still run on either side of the reply.
    fn run(mut self, rx: mpsc::Receiver<Command>) {
        'serve: loop {
            if self.idle() {
                self.answer();
                match rx.recv() {
                    Ok(cmd) if !cmd.closes() => self.take(cmd),
                    _ => break,
                }
            }
            // Taking a command only queues it, so the drain ends with what has arrived.
            while let Ok(cmd) = rx.try_recv() {
                if cmd.closes() {
                    break 'serve;
                }
                self.take(cmd);
            }
            self.answer();
            self.dispatch();
        }
        self.answer();
    }

    /// One transaction, after which [`Self::run`] takes what arrived meanwhile and decides again. What the serving core
    /// queued goes first: a write queued when a step of the work behind it is chosen is committed before another such
    /// step, and one that arrives just after waits behind that one transaction and no more. With nothing of the serving
    /// core queued, one step of the work behind it: the fork views, the purges, the title refold and the repairs, each
    /// kind in its turn.
    fn dispatch(&mut self) {
        if self.serving_queued() {
            self.append_transaction();
            return;
        }
        for _ in 0..4 {
            self.turn = (self.turn + 1) % 4;
            let ran = match self.turn {
                0 if self.views => {
                    self.view_step();
                    true
                }
                1 if !self.purges.is_empty() => {
                    self.purge_step();
                    true
                }
                2 if self.refold => {
                    self.maintenance_step();
                    true
                }
                3 if !self.repairs.is_empty() => {
                    self.repair_step();
                    true
                }
                _ => false,
            };
            if ran {
                return;
            }
        }
    }

    /// One append transaction within the R31 bounds.
    fn append_transaction(&mut self) {
        if self.upserts.is_empty() && self.small.is_empty() && self.projections.is_empty() {
            return;
        }
        let mut acks = Vec::new();
        // Requests the committed transaction answers with a refusal of their own.
        let mut refused: Vec<(Ack, String)> = Vec::new();
        let mut done_projections = 0usize;
        // How many projections, from the front, this transaction applied frames of.
        let mut reached = 0usize;
        let mut rows = 0usize;
        let mut bytes = 0usize;
        let mut waiting: Vec<(String, (Arc<CatalogHead>, u64))> = Vec::new();
        let mut edges: Vec<RowEdge> = Vec::new();
        // The edges the sink was told are about to commit.
        let mut told = 0usize;
        let watch = self.sink.get().is_some();
        // One snapshot for the whole transaction: a commit of the authority after it is projected by its own command, queued after.
        let archive = bound_archive(&self.archive);
        let read_seq = self.archive_reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let env = SmallEnv { archive: archive.as_deref(), read_seq, watch };
        let mut failing = Failing::Begin;
        // What the transaction moves in memory, put back when it fails, so that what it did not fail on is queued as it
        // was. Where each queued projection stood;
        let stood: Vec<(usize, Option<FramePos>)> = self.projections.iter().map(|pending| (pending.next, pending.hole)).collect();
        // the retirements its projections handed over, by the projection's place, each with the one it replaced;
        let mut retired: Vec<(usize, Option<Retiring>)> = Vec::new();
        // the rows its projections queued (`None`) or gave a newer head, with the head and order they had;
        type Stood = Option<(Arc<CatalogHead>, u64)>;
        let mut raised: Vec<(String, Stood)> = Vec::new();
        // and the rows it wrote.
        let mut wrote: Vec<WrittenRow> = Vec::new();
        let result = (|| -> rusqlite::Result<()> {
            #[cfg(test)]
            reconcile_seam::append_fault(&self.seam, reconcile_seam::AppendFault::Begin)?;
            let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            failing = Failing::Small;
            // Small commands (dirty marks, status): one row each.
            while rows < self.append_rows
                && let Some(cmd) = self.small.pop_front()
            {
                rows += 1;
                let out = SmallOut { acks: &mut acks, refused: &mut refused, edges: &mut edges };
                apply_small(&tx, cmd, &env, &mut self.labels, &mut self.refold, out)?;
            }
            // Projections in arrival order, frame by frame. A projection is answered once its catalog row is written, so past
            // the transaction's first frame (not held back, so a frame larger than the room the rows leave still goes in) a
            // frame goes in only while the rows still fit after it: one per session with a row to write, and this projection's.
            let mut first = true;
            'outer: for (at, pending) in self.projections.iter_mut().enumerate() {
                failing = Failing::Session(pending.projection.session.clone());
                #[cfg(test)]
                reconcile_seam::append_fault(&self.seam, reconcile_seam::AppendFault::Frames(pending.projection.session.clone()))?;
                // A projection queued after one of its session the index never took: its frames go in as before, and the
                // cursor stays at the first frame missing, with the session noted as one whose rows the next start rebuilds
                // from its log. No later projection moves the cursor across the missing one.
                if pending.next == 0
                    && pending.hole.is_none()
                    && let Some(frame) = pending.projection.frames.first()
                {
                    match placed(&tx, &pending.projection.session, frame)? {
                        Placed::Next => {}
                        Placed::Past(cursor) => {
                            tx.prepare_cached("INSERT INTO meta (key, value) VALUES (?1, '1') ON CONFLICT(key) DO NOTHING")?
                                .execute([hole_key(&pending.projection.session)])?;
                            pending.hole = Some(cursor);
                        }
                        // The index holds these frames already (another process's start projected them from the log):
                        // they are not written a second time.
                        Placed::Behind(cursor) => {
                            pending.next = pending.projection.frames.iter().take_while(|frame| frame.pos.ordinal < cursor.ordinal).count();
                        }
                    }
                }
                while pending.next < pending.projection.frames.len() {
                    let frame = &pending.projection.frames[pending.next];
                    let owed = if first { 0 } else { self.upserts.len() + usize::from(!self.upserts.contains_key(&pending.projection.session)) };
                    let budget = self.append_rows.saturating_sub(rows + owed);
                    if budget == 0 || bytes >= APPEND_BYTES {
                        break 'outer;
                    }
                    first = false;
                    reached = done_projections + 1;
                    let (used, complete) = apply_frame(&tx, &pending.projection.session, frame, budget, self.append_rows)?;
                    rows += used;
                    bytes += 64 * used;
                    if !complete {
                        break 'outer;
                    }
                    if let Some(cursor) = pending.hole {
                        let (ordinal, file_no, offset) = pos_params(&cursor);
                        tx.prepare_cached("UPDATE sessions SET projected_file_no = ?2, projected_offset = ?3, projected_ordinal = ?4 WHERE id = ?1")?
                            .execute(params![pending.projection.session, file_no, offset, ordinal])?;
                    }
                    pending.next += 1;
                }
                done_projections += 1;
                // The frames are in: the row is built from this projection's own head (a
                // newer explicit upsert of the session wins).
                let latest = pending.projection.head.clone();
                let seq = pending.seq;
                if let Some(retirement) = pending.retire.take()
                    && let Some(ack) = pending.ack.take()
                {
                    // An older retirement of the session still waiting is another writer's: this one replaces it, and the
                    // commit refuses the older.
                    retired.push((at, self.retires.insert(pending.projection.session.clone(), Retiring { retirement, ack })));
                }
                raised.push((pending.projection.session.clone(), self.upserts.get(&pending.projection.session).map(|entry| (entry.0.clone(), entry.3))));
                let entry = self.upserts.entry(pending.projection.session.clone()).or_insert_with(|| (latest.clone(), DirtyMark::Keep, Vec::new(), seq));
                if entry.3 < seq {
                    entry.0 = latest;
                    entry.3 = seq;
                }
            }
            let held: std::collections::HashSet<&str> = self
                .projections
                .iter()
                .skip(done_projections)
                .filter(|p| p.next > 0 || self.upserts.get(&p.projection.session).is_some_and(|entry| entry.3 > p.seq))
                .map(|p| p.projection.session.as_str())
                .collect();
            let ids: Vec<String> = self.upserts.keys().filter(|id| !held.contains(id.as_str())).cloned().collect();
            for id in ids {
                if rows >= self.append_rows || bytes >= APPEND_BYTES {
                    break;
                }
                failing = Failing::Session(id.clone());
                #[cfg(test)]
                let place = wrote.len();
                // The row of a retired writer is written clean only here, with the row, once the index holds its log
                // through its end; otherwise the mark stays and the retirement is refused.
                wrote.push(WrittenRow {
                    upsert: self.upserts.remove(&id).expect("listed"),
                    retiring: self.retires.remove(&id),
                    refusal: None,
                    written: 0,
                    id: id.clone(),
                });
                let row = wrote.last_mut().expect("pushed");
                rows += 1;
                #[cfg(test)]
                reconcile_seam::append_fault(&self.seam, reconcile_seam::AppendFault::RowAt(place))?;
                if let Some(retiring) = &row.retiring {
                    row.refusal = retire_refusal(&tx, &id, retiring)?;
                    // A row that waits for a fork view no step of this process can run (its base is behind the fork point,
                    // holed, or waits itself) is not waited for: the retirement is refused now, and the mark stays.
                    if row.refusal.is_none() && crate::message_index::has_pending_view(&tx, &id)? && !crate::message_index::view_runnable(&tx, &id)? {
                        row.refusal = Some(format!("{id}: its row waits for a fork view that cannot be computed before the next start"));
                    }
                }
                let dirty = if row.retiring.is_some() && row.refusal.is_none() { DirtyMark::Clear } else { row.upsert.1 };
                // An anonymous mark (a creation's row) is no activation's until that activation names it.
                if dirty != DirtyMark::Keep {
                    tx.prepare_cached("DELETE FROM meta WHERE key = ?1")?.execute([mark_key(&id)])?;
                }
                let (written, edge) = upsert_edge(&tx, &row.upsert.0, dirty, &self.labels, watch, archive.as_deref())?;
                edges.extend(edge);
                row.written = written;
                // The row waits for its fork view, which the next steps compute: the retirement waits with it, its mark
                // kept until then.
                if let Some(retiring) = &row.retiring
                    && row.refusal.is_none()
                    && written == 0
                {
                    tx.prepare_cached("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")?
                        .execute(params![mark_key(&id), retiring.retirement.activation.to_string()])?;
                }
                bytes += written;
            }
            if let Some(sink) = self.sink.get().filter(|_| !edges.is_empty()) {
                sink.writing(edges.len());
                told = edges.len();
            }
            failing = Failing::Commit;
            #[cfg(test)]
            reconcile_seam::append_fault(&self.seam, reconcile_seam::AppendFault::Commit)?;
            tx.commit()
        })();
        // Still locked after SQLite's own wait: the lock is a foreign connection's, and no fault of what is queued.
        let locked =
            matches!(failing, Failing::Begin) && matches!(&result, Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::DatabaseBusy);
        #[cfg(test)]
        let injected = matches!(&result, Err(rusqlite::Error::SqliteFailure(_, Some(why))) if why == reconcile_seam::INJECTED);
        #[cfg(not(test))]
        let injected = false;
        let result = result.map_err(|e| e.to_string());
        // The count told to the sink is given back before anything can leave this function: the assertion below panics in a
        // debug build, and a count never given back makes every later listing wait for ever.
        if result.is_err()
            && told > 0
            && let Some(sink) = self.sink.get()
        {
            sink.dropped(told);
        }
        // The only failure a test build lets by is the lock of a foreign connection (and one a test injected): any other
        // is a defect of what the transaction wrote.
        debug_assert!(result.is_ok() || locked || injected, "append transaction failed: {result:?}");
        #[cfg(test)]
        if result.is_ok() {
            self.trace("serving", "", rows);
        } else if locked {
            self.trace("locked", "", 0);
        }
        let finished: Vec<Pending> = if result.is_ok() {
            for (at, older) in retired {
                if let Some(older) = older {
                    refused.push((older.ack, format!("{}: retired again before its row was written", self.projections[at].projection.session)));
                }
            }
            for WrittenRow { id, upsert: (head, _, waiters, seq), retiring, refusal, written } in wrote {
                if written == 0 {
                    waiting.push((id.clone(), (head, seq)));
                }
                match (retiring, refusal) {
                    (Some(retiring), None) if written == 0 => drop(self.retires.insert(id, retiring)),
                    (Some(retiring), None) => acks.push(retiring.ack),
                    (Some(retiring), Some(why)) => refused.push((retiring.ack, why)),
                    (None, _) => {}
                }
                acks.extend(waiters);
            }
            self.projections.drain(..done_projections).collect()
        } else {
            // Nothing of the transaction is in. What it failed on is lost to the index: the session it was writing; when
            // the commit failed, every session it held; when it did not begin for a reason other than a lock, everything
            // queued. Each failure so takes its work off the queue, and the next transaction is another. Everything else
            // is queued as it was and goes in with that one. A projection dropped here leaves its session with a later
            // one past its cursor: that one is applied, the session is noted as holed, and the next start purges its rows
            // and replays its log from the first frame, behind the serving core.
            let unbegun = matches!(failing, Failing::Begin) && !locked;
            let mut failed: std::collections::HashSet<String> = match &failing {
                Failing::Begin | Failing::Small => std::collections::HashSet::new(),
                Failing::Session(session) => std::collections::HashSet::from([session.clone()]),
                Failing::Commit => self.projections.iter().take(reached.max(done_projections)).map(|p| p.projection.session.clone()).collect(),
            };
            if matches!(failing, Failing::Commit) {
                failed.extend(wrote.iter().map(|row| row.id.clone()));
            }
            for row in wrote.into_iter().rev() {
                if let Some(retiring) = row.retiring {
                    self.retires.insert(row.id.clone(), retiring);
                }
                self.upserts.insert(row.id, row.upsert);
            }
            for (session, before) in raised.into_iter().rev() {
                match before {
                    Some((head, seq)) => {
                        if let Some(entry) = self.upserts.get_mut(&session) {
                            (entry.0, entry.3) = (head, seq);
                        }
                    }
                    None => drop(self.upserts.remove(&session)),
                }
            }
            for (at, older) in retired.into_iter().rev() {
                let pending = &mut self.projections[at];
                if let Some(Retiring { retirement, ack }) = self.retires.remove(&pending.projection.session) {
                    (pending.retire, pending.ack) = (Some(retirement), Some(ack));
                }
                if let Some(older) = older {
                    self.retires.insert(pending.projection.session.clone(), older);
                }
            }
            for (pending, (next, hole)) in self.projections.iter_mut().zip(stood) {
                (pending.next, pending.hole) = (next, hole);
            }
            if unbegun {
                failed.extend(self.projections.iter().map(|p| p.projection.session.clone()));
                failed.extend(self.upserts.keys().cloned());
                failed.extend(self.retires.keys().cloned());
                // A small command's answer is its own to send: dropped, its sender is told the writer did not answer.
                self.small.clear();
            }
            for session in &failed {
                acks.extend(self.upserts.remove(session).into_iter().flat_map(|upsert| upsert.2));
                acks.extend(self.retires.remove(session).map(|retiring| retiring.ack));
            }
            // The small commands that ran are answered with the failure, their own refusals among them.
            acks.extend(refused.drain(..).map(|(ack, _)| ack));
            let (dropped, kept): (VecDeque<Pending>, VecDeque<Pending>) = self.projections.drain(..).partition(|p| failed.contains(&p.projection.session));
            self.projections = kept;
            dropped.into()
        };
        self.answers.extend(refused.into_iter().map(|(ack, why)| (ack, Err(DbError::Write(why)))));
        // A projection that finished may have opened a view, or advanced the watermark a
        // pending view waits for.
        let advanced = !finished.is_empty();
        for p in finished {
            let Some(ack) = p.ack else { continue };
            match self.upserts.get_mut(&p.projection.session) {
                // Its session's row is still to be written (it did not fit in this transaction, or is held for a projection
                // of the session still queued): the projection is answered with the transaction that writes it, and fails
                // with it, so whoever waits on its answer (a list's fence, a header's `indexed`) finds the row it made.
                Some(entry) if result.is_ok() => entry.2.push(ack),
                _ => acks.push(ack),
            }
        }
        if result.is_ok() {
            self.waiting.extend(waiting);
            self.views |= advanced;
            // Durable: the sink may read the rows back.
            if let Some(sink) = self.sink.get() {
                for edge in edges {
                    sink.written(edge);
                }
            }
        }
        self.answers.extend(acks.into_iter().map(|ack| (ack, result.clone().map_err(DbError::Write))));
    }

    /// One refold step: placeholder titles take the current labels' folds.
    fn maintenance_step(&mut self) {
        let labels = self.labels.clone();
        let result = (|| -> rusqlite::Result<bool> {
            let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let mut budget = STEP_ROWS;
            for kind in [TitleKind::Image, TitleKind::Video, TitleKind::File] {
                let folded = fold(labels.label(kind));
                let changed = tx
                    .prepare_cached(
                        "UPDATE sessions SET title_fold = ?1 WHERE sid IN (SELECT sid FROM sessions
                         WHERE title_kind = ?2 AND title_fold <> ?1 LIMIT ?3)",
                    )?
                    .execute(params![folded, kind.as_str(), budget as i64])?;
                budget -= changed;
                if budget == 0 {
                    tx.commit()?;
                    return Ok(false);
                }
            }
            tx.execute("DELETE FROM meta WHERE key = ?1", [REFOLD_JOB])?;
            tx.commit()?;
            Ok(true)
        })();
        // A failed step is retried at the next turn of the loop.
        if let Ok(true) = result {
            self.refold = false;
        }
    }
}

fn pos_params(pos: &FramePos) -> (i64, i64, i64) {
    (pos.ordinal as i64, i64::from(pos.file_no), pos.offset as i64)
}

fn write_prompt(tx: &Transaction<'_>, session: &str, ordinal: i64, text: &str) -> rusqlite::Result<()> {
    let key = crate::title::prompt_history_key(text);
    tx.prepare_cached(
        "INSERT OR REPLACE INTO prompt_occurrences (session, ordinal, key, text, superseded_rev)
         VALUES (?1, ?2, ?3, ?4, NULL)",
    )?
    .execute(params![session, ordinal, key, text])?;
    tx.prepare_cached(
        "INSERT INTO prompt_history (session, key, ordinal, text) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(session, key) DO UPDATE SET ordinal = excluded.ordinal, text = excluded.text",
    )?
    .execute(params![session, key, ordinal, text])?;
    Ok(())
}

fn write_aliases(tx: &Transaction<'_>, session: &str, aliases: &[String], ordinal: i64) -> rusqlite::Result<()> {
    for alias in aliases {
        tx.prepare_cached("INSERT OR IGNORE INTO history_alias (session, alias, ordinal) VALUES (?1, ?2, ?3)")?.execute(params![session, alias, ordinal])?;
    }
    Ok(())
}

fn serde_name<T: serde::Serialize>(v: &T) -> String {
    match serde_json::to_value(v).expect("enum encodes") {
        serde_json::Value::String(s) => s,
        other => unreachable!("enum as {other}"),
    }
}

/// Applies one frame within `budget` rows: `(rows written, frame complete)`. Only a
/// rewind can be incomplete; it resumes where it stopped (its updates are idempotent).
fn apply_frame(tx: &Transaction<'_>, session: &str, frame: &ProjectedFrame, budget: usize, cap: usize) -> rusqlite::Result<(usize, bool)> {
    let need = frame.rows();
    if need > budget && need <= cap {
        return Ok((0, false));
    }
    let (ordinal, file_no, offset) = pos_params(&frame.pos);
    let len = frame.frame_len as i64;
    let mut used = need;
    match &frame.kind {
        FrameKind::Session { base } => {
            if let Some(base) = base {
                tx.prepare_cached("INSERT OR IGNORE INTO fork_edges (base, child) VALUES (?1, ?2)")?.execute(params![base.session.as_str(), session])?;
                let end = base.end_ordinal_exclusive as i64;
                crate::message_index::open_view(tx, session, ordinal, base.session.as_str(), end, end)?;
            }
        }
        FrameKind::Item { iid, turn, form, model, visible, prompt, msg, facets, aliases } => {
            if let Some(msg) = msg {
                crate::message_index::add_item(tx, session, ordinal, (file_no, offset, len), iid, msg)?;
            }
            if let Some(text) = prompt {
                write_prompt(tx, session, ordinal, text)?;
            }
            tx.prepare_cached(
                "INSERT OR REPLACE INTO history (session, ordinal, iid, turn, form, model, visible, file_no,
                 frame_offset, frame_len, amend_ordinal, superseded_rev, facets, end_form)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, ?11,
                 coalesce((SELECT end_form FROM turns WHERE session = ?1 AND rid = ?4), 0))",
            )?
            .execute(params![
                session,
                ordinal,
                iid,
                turn,
                i64::from(*form == Form::Display),
                model,
                visible,
                file_no,
                offset,
                len,
                facets.as_ref().map(|f| serde_json::to_string(f).expect("facets are plain data"))
            ])?;
            write_aliases(tx, session, aliases, ordinal)?;
        }
        FrameKind::Amend { iid, msg, aliases } => {
            if let Some(msg) = msg {
                crate::message_index::amend(tx, session, iid, ordinal, (file_no, offset, len), msg)?;
            }
            let target: Option<i64> = tx
                .prepare_cached(
                    "SELECT ordinal FROM history WHERE session = ?1 AND iid = ?2 AND superseded_rev IS NULL
                     ORDER BY ordinal DESC LIMIT 1",
                )?
                .query_row(params![session, iid], |r| r.get(0))
                .optional()?;
            if let Some(target) = target {
                tx.prepare_cached(
                    "INSERT OR REPLACE INTO amends (session, ordinal, target_ordinal, file_no, frame_offset,
                     frame_len, superseded_rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
                )?
                .execute(params![session, ordinal, target, file_no, offset, len])?;
                tx.prepare_cached("UPDATE history SET amend_ordinal = ?3 WHERE session = ?1 AND ordinal = ?2")?.execute(params![session, target, ordinal])?;
                write_aliases(tx, session, aliases, target)?;
            }
        }
        FrameKind::Rewind { to_ordinal } => {
            let (rewound, complete) = apply_rewind(tx, session, *to_ordinal as i64, ordinal, budget)?;
            if !complete {
                return Ok((rewound, false));
            }
            used = rewound;
        }
        FrameKind::Compacted { rows, dropped, .. } => {
            write_compaction_row(tx, session, frame)?;
            if let Some(dropped) = dropped {
                let mut put = tx.prepare_cached("INSERT OR IGNORE INTO compaction_dropped (session, kind, id, ordinal) VALUES (?1, ?2, ?3, ?4)")?;
                for id in &dropped.message_ids {
                    put.execute(params![session, 0, id, ordinal])?;
                }
                for id in &dropped.call_ids {
                    put.execute(params![session, 1, id, ordinal])?;
                }
            }
            // The context restarts here: a new epoch whose totals count from the replacement.
            crate::message_index::add_compaction(tx, session, ordinal, (file_no, offset, len), rows)?;
        }
        FrameKind::Run { rid, phase, end } => match phase {
            RunPhase::Started => {
                tx.prepare_cached(
                    "INSERT OR REPLACE INTO turns (session, rid, started_ordinal, end_ordinal, phase, superseded_rev, end_form)
                     VALUES (?1, ?2, ?3, NULL, 'started', NULL, ?4)",
                )?
                .execute(params![session, rid, ordinal, i64::from(*end == Some(TurnEndForm::Display))])?;
                // The turn's input row is written before this frame: it holds the turn's form too.
                if *end == Some(TurnEndForm::Display) {
                    tx.prepare_cached("UPDATE history INDEXED BY history_turn SET end_form = 1 WHERE session = ?1 AND turn = ?2 AND model = 1")?
                        .execute(params![session, rid])?;
                }
            }
            RunPhase::Attempt => {}
            ended => {
                tx.prepare_cached("UPDATE turns SET end_ordinal = ?3, phase = ?4 WHERE session = ?1 AND rid = ?2")?.execute(params![
                    session,
                    rid,
                    ordinal,
                    serde_name(ended)
                ])?;
            }
        },
        FrameKind::Approval { aid, rid, phase } => match phase {
            ApprovalPhase::Requested => {
                tx.prepare_cached(
                    "INSERT OR REPLACE INTO approvals (session, aid, rid, ordinal, file_no, frame_offset, frame_len)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )?
                .execute(params![session, aid, rid, ordinal, file_no, offset, len])?;
            }
            ApprovalPhase::Decided | ApprovalPhase::Expired => {
                tx.prepare_cached("DELETE FROM approvals WHERE session = ?1 AND aid = ?2")?.execute(params![session, aid])?;
            }
        },
        // No rewind mark: the boundary lives while its anchor row does (FORMAT.md §5.3).
        FrameKind::ModelSwitch { anchor, entry } => {
            tx.prepare_cached(
                "INSERT OR REPLACE INTO model_switches (session, ordinal, anchor_ordinal, anchor_iid, provider,
                 model_id, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?
            .execute(params![
                session,
                ordinal,
                anchor.ordinal as i64,
                anchor.iid.as_str(),
                entry.provider.as_str(),
                entry.model_id.as_str(),
                entry.at
            ])?;
        }
        FrameKind::Other => {}
    }
    frame_tail(tx, session, frame)?;
    Ok((used, true))
}

/// What every frame ends with, once its own rows are in: its op, its receipt, and the session's cursor past it.
fn frame_tail(tx: &Transaction<'_>, session: &str, frame: &ProjectedFrame) -> rusqlite::Result<()> {
    let (ordinal, file_no, offset) = pos_params(&frame.pos);
    let len = frame.frame_len as i64;
    if let Some(op) = &frame.op {
        tx.prepare_cached(
            "INSERT INTO thread_ops (session, op_id, method, payload_digest, state, ordinal, file_no,
             frame_offset, frame_len) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(session, op_id) DO UPDATE SET state = excluded.state, ordinal = excluded.ordinal,
             file_no = excluded.file_no, frame_offset = excluded.frame_offset, frame_len = excluded.frame_len",
        )?
        .execute(params![session, op.id, op.method, op.digest, serde_name(&op.state), ordinal, file_no, offset, len])?;
    }
    if let Some(receipt) = &frame.receipt {
        tx.prepare_cached("INSERT OR IGNORE INTO submissions (session, submission_id, ordinal, answer) VALUES (?1, ?2, ?3, ?4)")?.execute(params![
            session,
            receipt.submission,
            ordinal,
            receipt.answer.to_string()
        ])?;
    }
    tx.prepare_cached(
        "UPDATE sessions SET projected_file_no = ?2, projected_offset = ?3, projected_ordinal = ?4,
         newest_file_no = max(newest_file_no, ?2), history_rev = ?5, row_count = ?6, visible_count = ?7
         WHERE id = ?1",
    )?
    .execute(params![session, file_no, offset + len, ordinal + 1, frame.history_rev as i64, frame.rows as i64, frame.visible_rows as i64])?;
    Ok(())
}

/// One frame within what is left of `budget`, from the `done` parts of it already in: `(parts in now, frame complete)`.
/// Room is taken before a row is written. A frame that fits a transaction goes in whole, or waits for the next when the
/// room left is short of it; a compaction larger than a transaction goes in a row at a time, and a rewind in its own
/// bounded steps, the cursor moving only with the last part. Only an item with more aliases than a transaction has rows
/// goes in whole past the bound, alone in its transaction.
fn apply_frame_part(tx: &Transaction<'_>, session: &str, frame: &ProjectedFrame, done: usize, budget: &mut Budget) -> rusqlite::Result<(usize, bool)> {
    let need = frame.rows() + 2;
    match &frame.kind {
        FrameKind::Rewind { .. } => {
            // Its updates are idempotent and sized to the room they are given, at least one version (four rows).
            let room = if budget.fresh() { budget.rows.max(4) } else { budget.rows };
            if room < 4 {
                return Ok((done, false));
            }
            let (used, complete) = apply_frame(tx, session, frame, room, room)?;
            budget.charge(used + 2 * usize::from(complete));
            Ok((done + used.max(1), complete))
        }
        FrameKind::Compacted { .. } if need > budget.cap => apply_compaction_part(tx, session, frame, done, budget),
        _ => {
            if !budget.reserve(need) {
                if !(budget.fresh() && need > budget.cap) {
                    return Ok((done, false));
                }
                budget.charge(need);
            }
            apply_frame(tx, session, frame, usize::MAX, usize::MAX)?;
            Ok((done, true))
        }
    }
}

/// The `compactions` row of a `compacted` frame: the divider sits at the compaction's own record, so `boundary` is its
/// ordinal.
const COMPACTION_ROW_SQL: &str = "INSERT OR REPLACE INTO compactions (session, ordinal, cid, file_no, frame_offset, frame_len,
     boundary, at, drop_mode, silent, superseded_rev)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)";

fn write_compaction_row(tx: &Transaction<'_>, session: &str, frame: &ProjectedFrame) -> rusqlite::Result<()> {
    let FrameKind::Compacted { cid, at, mode, silent, .. } = &frame.kind else { unreachable!("a compaction") };
    let (ordinal, file_no, offset) = pos_params(&frame.pos);
    tx.prepare_cached(COMPACTION_ROW_SQL)?.execute(params![
        session,
        ordinal,
        cid,
        file_no,
        offset,
        frame.frame_len as i64,
        ordinal,
        at,
        *mode as i64,
        i64::from(*silent)
    ])?;
    Ok(())
}

/// A compaction with more rows than one transaction holds, from part `done` on while `budget` has room: its own row, each
/// dropped id, each replacement row, then its epoch with the frame's tail. Every part is written as the whole frame would
/// write it, and a part written twice is the same row.
fn apply_compaction_part(tx: &Transaction<'_>, session: &str, frame: &ProjectedFrame, done: usize, budget: &mut Budget) -> rusqlite::Result<(usize, bool)> {
    let FrameKind::Compacted { rows, dropped, .. } = &frame.kind else { unreachable!("a compaction") };
    let (ordinal, file_no, offset) = pos_params(&frame.pos);
    let len = frame.frame_len as i64;
    let ids: Vec<(i64, &String)> =
        dropped.iter().flat_map(|dropped| dropped.message_ids.iter().map(|id| (0, id)).chain(dropped.call_ids.iter().map(|id| (1, id)))).collect();
    let total = 2 + ids.len() + rows.len();
    let mut part = done;
    while part < total {
        if !budget.reserve(1) {
            return Ok((part, false));
        }
        if part == 0 {
            write_compaction_row(tx, session, frame)?;
        } else if part <= ids.len() {
            let (kind, id) = ids[part - 1];
            tx.prepare_cached("INSERT OR IGNORE INTO compaction_dropped (session, kind, id, ordinal) VALUES (?1, ?2, ?3, ?4)")?
                .execute(params![session, kind, id, ordinal])?;
        } else if part <= ids.len() + rows.len() {
            crate::message_index::add_compaction_row(tx, session, ordinal, (file_no, offset, len), rows, part - 1 - ids.len())?;
        } else {
            crate::message_index::add_compaction_epoch(tx, session, ordinal, rows)?;
            frame_tail(tx, session, frame)?;
        }
        part += 1;
    }
    Ok((total, true))
}

/// `frames` from `*next` on while `budget` has room: one transaction's worth, with where it goes on (`next`, and `part` of
/// that frame). `true` once every frame is in.
fn apply_frames(
    tx: &Transaction<'_>,
    session: &str,
    frames: &[ProjectedFrame],
    next: &mut usize,
    part: &mut usize,
    budget: &mut Budget,
) -> rusqlite::Result<bool> {
    while *next < frames.len() {
        let (done, complete) = apply_frame_part(tx, session, &frames[*next], *part, budget)?;
        if !complete {
            *part = done;
            return Ok(false);
        }
        *part = 0;
        *next += 1;
    }
    Ok(true)
}

/// Supersedes what the rewind frame at `ordinal` takes back down to `to`, within `budget` rows of writes (raised to a
/// small floor so every call makes progress); the flag is whether it all fit.
fn apply_rewind(tx: &Transaction<'_>, session: &str, to: i64, ordinal: i64, budget: usize) -> rusqlite::Result<(usize, bool)> {
    // The smallest unit of progress is one version (three writes): a budget below
    // that is raised, so a tiny budget still advances.
    let mut left = budget.saturating_sub(1).max(3);
    let mut used = 1;
    // Prompts first: each superseded occurrence moves its key to the newest live
    // one (two rows per occurrence).
    let keys: Vec<String> = tx
        .prepare_cached(
            "UPDATE prompt_occurrences SET superseded_rev = ?3 WHERE session = ?1 AND ordinal IN
             (SELECT ordinal FROM prompt_occurrences WHERE session = ?1 AND ordinal >= ?2 AND ordinal < ?3
              AND superseded_rev IS NULL LIMIT ?4) RETURNING key",
        )?
        .query_map(params![session, to, ordinal, (left / 2) as i64], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for key in &keys {
        refresh_prompt(tx, session, key)?;
    }
    left -= 2 * keys.len();
    used += 2 * keys.len();
    if left < 2 {
        return Ok((used, false));
    }
    for table in ["history", "amends", "compactions"] {
        let sql = format!(
            "UPDATE {table} SET superseded_rev = ?3 WHERE session = ?1 AND ordinal IN
             (SELECT ordinal FROM {table} WHERE session = ?1 AND ordinal >= ?2 AND ordinal < ?3
              AND superseded_rev IS NULL LIMIT ?4)"
        );
        let n = tx.prepare_cached(&sql)?.execute(params![session, to, ordinal, left as i64])?;
        left -= n;
        used += n;
        if left == 0 {
            return Ok((used, false));
        }
    }
    let (n, complete) = crate::message_index::rewind(tx, session, to, ordinal, left)?;
    debug_assert!(n <= left, "rewind wrote {n} rows with {left} left");
    left = left.saturating_sub(n);
    used += n;
    if !complete || left == 0 {
        return Ok((used, false));
    }
    let n = tx
        .prepare_cached(
            "UPDATE turns SET superseded_rev = ?3 WHERE session = ?1 AND rid IN
             (SELECT rid FROM turns WHERE session = ?1 AND started_ordinal >= ?2
              AND started_ordinal < ?3 AND superseded_rev IS NULL LIMIT ?4)",
        )?
        .execute(params![session, to, ordinal, left as i64])?;
    left -= n;
    used += n;
    // Surviving items whose live amend was superseded fall back to the newest live one.
    let n = tx
        .prepare_cached(
            "UPDATE history SET amend_ordinal = (SELECT max(a.ordinal) FROM amends a
               WHERE a.session = history.session AND a.target_ordinal = history.ordinal
               AND a.superseded_rev IS NULL)
             WHERE session = ?1 AND ordinal IN (SELECT ordinal FROM history WHERE session = ?1
               AND ordinal < ?2 AND amend_ordinal >= ?2 AND superseded_rev IS NULL LIMIT ?3)",
        )?
        .execute(params![session, to, left as i64])?;
    left -= n;
    used += n;
    let n = tx
        .prepare_cached(
            "DELETE FROM approvals WHERE session = ?1 AND aid IN (SELECT aid FROM approvals
             WHERE session = ?1 AND ordinal >= ?2 LIMIT ?3)",
        )?
        .execute(params![session, to, left as i64])?;
    left -= n;
    used += n;
    Ok((used, left != 0))
}

/// Points `key`'s prompt-history row at its newest live occurrence, or removes it.
fn refresh_prompt(tx: &Transaction<'_>, session: &str, key: &str) -> rusqlite::Result<()> {
    let newest: Option<(i64, String)> = tx.prepare_cached(PROMPT_NEWEST_SQL)?.query_row([session, key], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    match newest {
        Some((ordinal, text)) => tx
            .prepare_cached("UPDATE prompt_history SET ordinal = ?3, text = ?4 WHERE session = ?1 AND key = ?2")?
            .execute(params![session, key, ordinal, text])?,
        None => tx.prepare_cached("DELETE FROM prompt_history WHERE session = ?1 AND key = ?2")?.execute([session, key])?,
    };
    Ok(())
}

/// Notes each of `sessions` as owed an archive projection, at read sequence `noted` or later.
fn raise_debts(owed: &mut HashMap<String, u64>, sessions: impl IntoIterator<Item = String>, noted: u64) {
    for id in sessions {
        let debt = owed.entry(id).or_insert(noted);
        *debt = (*debt).max(noted);
    }
}

// ---------------------------------------------------------------------------------------
// Store handle and reads

struct Shared {
    path: PathBuf,
    /// The read pool and the writer channel, with the sessions still owed a repair.
    gate: gate::Gate,
    rows: RowSinkCell,
    /// The archive authority's snapshot, which the writer resolves each row through and the lead listing reads.
    archive: ArchiveCell,
    /// The sessions whose archive projection failed ([`SqliteStore::project_archive`]), each with the writer's read sequence when
    /// the failure was noted: owed until a projection that read its state after that commits. A reader of the projected
    /// `archived` column settles them first ([`SqliteStore::search`]), so it never reads a row the authority disagrees with.
    archive_owed: Mutex<HashMap<String, u64>>,
    /// How the sensitive rewrites of this start's withheld sessions ended, for those that wait for one ([`withheld::Rewrites`]).
    rewrites: withheld::Rewrites,
    /// The writer's read sequence ([`Writer::archive_reads`]).
    archive_reads: Arc<std::sync::atomic::AtomicU64>,
    /// Projections a test makes fail.
    #[cfg(any(test, feature = "test-support"))]
    archive_faults: std::sync::atomic::AtomicUsize,
    #[cfg(feature = "test-support")]
    refuse_reproject: std::sync::atomic::AtomicBool,
    /// What a test runs inside the next worker-index load, after its rows were read and before its read transaction ends.
    #[cfg(test)]
    worker_read_hold: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// The next projection's bookkeeping a test holds once its write answered: `arrived` is told, then `go` is awaited.
    #[cfg(any(test, feature = "test-support"))]
    archive_ack_hold: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
    /// The writer thread, joined by [`SqliteStore::close`].
    writer: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// The threads of the repairs owed at open, when there were any; joined by [`SqliteStore::close`].
    repairs: Mutex<Vec<std::thread::JoinHandle<()>>>,
    /// [`SqliteStore::rebuilding`].
    rebuilding: bool,
    /// [`SqliteStore::boot_steps`].
    boot_steps: Vec<(&'static str, Instant)>,
}

/// Cloneable handle on `index/store.sqlite`. The writer thread finishes the queued
/// requests and exits when the last handle is dropped.
#[derive(Clone)]
pub struct SqliteStore {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for SqliteStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteStore").field("path", &self.shared.path).finish()
    }
}

/// One live history row of a page, newest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRow {
    pub session: String,
    pub ordinal: u64,
    pub iid: String,
    pub turn: Option<String>,
    pub form: Form,
    pub model: bool,
    pub pos: FramePos,
    pub frame_len: u64,
    /// The live amend whose body replaces the item's.
    pub amend: Option<(FramePos, u64)>,
    /// A model message a compaction took out of the context: shown, but out of the
    /// context (1.4.5 `archived: true`). The rows the compaction kept are live.
    pub archived: bool,
    /// Its text row left the context (the message id is in a later compaction's identities,
    /// or the compaction takes every row before its divider).
    pub dropped_text: bool,
    /// The tool calls of this message that left the context. A message that lost only
    /// part of itself is not `archived`: the transcript shows these parts as archived rows.
    pub dropped_calls: Vec<String>,
    /// The compactions (oldest first) whose replacement kept this message: where its
    /// rewritten copies are. A kept message that lost part of itself shows that part as an
    /// archived row before the compaction's divider (1.4.5 `compactionArchiveProjection`:
    /// the copy before against the copy kept): copy 0 is this row, copy `n` is `kept[n-1]`.
    /// A dropped message (`archived`) is its newest copy, whole.
    pub kept: Vec<KeptCopy>,
    /// The display-only model-switch boundaries anchored on this row (the 1.4.5
    /// `meta.modelSwitches` of the message), in the order they were recorded: shown after
    /// the row's own items.
    pub model_switches: Vec<ModelSwitchEntry>,
    /// Where the row's turn stores its end (its `started` record's `end`), when not on a message of the turn: such
    /// a row shows no end of its own.
    pub end: Option<TurnEndForm>,
}

/// One rewritten copy of a message: entry `idx` of the replacement of the `compacted`
/// frame at `compaction`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeptCopy {
    pub compaction: FramePos,
    pub frame_len: u64,
    pub idx: u32,
}

/// A `thread_ops` row: the op and the frame that carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadOp {
    pub method: String,
    pub payload_digest: String,
    pub state: crate::schema::record::OpState,
    pub pos: FramePos,
    pub frame_len: u64,
}

/// One level of a session's lineage: the session and, for a base, the end of the range
/// the child continues (`Base::end_ordinal_exclusive`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineageLevel {
    pub session: String,
    pub end: Option<u64>,
}

/// The sessions of a lineage: those a read over it concerns.
fn levels(lineage: &[LineageLevel]) -> Vec<&str> {
    lineage.iter().map(|level| level.session.as_str()).collect()
}

/// Where the next older page starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageCursor {
    pub history_rev: u64,
    pub level: usize,
    pub before: u64,
}

/// Where the next newer page starts: the rows of lineage level `level` at or above `from`, then each newer level's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AfterCursor {
    pub history_rev: u64,
    pub level: usize,
    pub from: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchCursor {
    pub archived: bool,
    pub activity: f64,
    pub id_key: Vec<u8>,
}

/// What a read-only look at the SQLite file at `path` finds: its `application_id` and the number of objects in `sqlite_master`, each as SQLite
/// answered it; `None` when the file cannot be opened at all. Changes nothing.
pub fn read_only_identity(path: &Path) -> Option<(rusqlite::Result<i64>, rusqlite::Result<i64>)> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let id = conn.pragma_query_value(None, "application_id", |r| r.get(0));
    let objects = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0));
    Some((id, objects))
}

impl SqliteStore {
    /// The one entry point of the index: opens `<data>/index/store.sqlite` and starts its
    /// writer thread; reads run as jobs on `read_lane`. A missing or unreadable file, or
    /// one of another `application_id`/`user_version`, is first rebuilt on this maintenance
    /// job from every log under `<data>/sessions` (FORMAT.md §8.2): it is never opened or
    /// altered in place, and `DbError::Rebuild` never reaches the caller.
    ///
    /// The boot purge runs here, before the store is returned, so it precedes every thread
    /// open and create: every session folder without its first log file is removed (a
    /// create publishes `log.000000` before anything else, and a purge unlinks it first, so
    /// such a folder is a half-finished create or purge, which no rebuild indexes), with its
    /// id's index rows; then every deleted session no fork reads (`purge_deleted`).
    /// The repairs owed at open start at the first access that waits for one, or the withheld set's commit: for an opener
    /// that may never commit one (a tool, a test host).
    pub fn open(lane: &InLane<MaintenanceIo>, thread: SqliteWriterThread, read_lane: InteractiveIo, data: &Path) -> Result<SqliteStore, DbError> {
        Self::open_reporting(lane, thread, read_lane, data, None, RepairStart::FirstWait)
    }

    /// [`Self::open`], reporting a rebuild's sessions done and total to `progress` as the repairs that make it run.
    ///
    /// An index that has to be made anew (missing, of another identity or format, or unreadable) is published empty with
    /// every session owed its rows ([`fresh_index`]), so the open takes no longer than any other: the rows are projected
    /// behind the serving core by the repairs, most recently written session first, on several threads. Until a session's
    /// repair ends, an access that names it waits for that repair (asked for ahead of the rest), a listing does not hold it,
    /// and a reader that decides from every row waits for them all ([`Self::reconciled`]). What is owed outlives a stop.
    #[allow(clippy::disallowed_methods, reason = "runs on the maintenance lane job (lane proof argument)")]
    pub fn open_reporting(
        lane: &InLane<MaintenanceIo>,
        thread: SqliteWriterThread,
        read_lane: InteractiveIo,
        data: &Path,
        progress: Option<&Arc<RebuildProgress>>,
        start: RepairStart,
    ) -> Result<SqliteStore, DbError> {
        let path = data.join(INDEX_FILE);
        let path = path.as_path();
        let mut boot_steps = Vec::new();
        let writer = Writer::boot(lane, data, path, &mut boot_steps)?;
        let dirty = owed_repairs(&writer.conn)?;
        let rebuild = rebuild_order(&writer.conn)?;
        let workers = worker_order(&writer.conn)?;
        boot_steps.push(("repairs-listed", Instant::now()));
        let rebuilding = !rebuild.is_empty();
        let progress = progress.filter(|_| rebuilding).cloned();
        if let Some(progress) = &progress {
            progress.begin(dirty.len());
        }
        let rows = writer.sink.clone();
        let archive = writer.archive.clone();
        let archive_reads = writer.archive_reads.clone();
        let ranks = writer.ranks.clone();
        let (sender, rx) = mpsc::channel();
        let handle = thread.spawn_thread("mixdog-index-writer", move |_| writer.run(rx)).map_err(|e| DbError::Write(e.to_string()))?;
        let (gate, repairer) = gate::Gate::new(ReadPool::new(path, read_lane), sender, dirty, workers, rebuild, progress, start);
        let _ = ranks.set(gate.ranks());
        // The repairs' own threads, off the read lane: they wait there until they may start ([`gate::Repairer::next`]). A
        // rebuild reads its logs on one per core, as the one before serving did; a start's own repairs take one.
        let threads = if rebuilding { std::thread::available_parallelism().map_or(1, usize::from) } else { 1 };
        let mut repairs = Vec::new();
        if let Some(repairer) = repairer {
            let repairer = Arc::new(repairer);
            for _ in 0..threads {
                let (repairer, data) = (repairer.clone(), data.to_path_buf());
                repairs.push(thread.spawn_thread("mixdog-index-repair", move |_| repair_owed(&repairer, &data)).map_err(|e| DbError::Write(e.to_string()))?);
            }
        }
        Ok(SqliteStore {
            shared: Arc::new(Shared {
                path: path.to_path_buf(),
                gate,
                rows,
                archive,
                archive_owed: Mutex::default(),
                rewrites: withheld::Rewrites::default(),
                archive_reads,
                #[cfg(any(test, feature = "test-support"))]
                archive_faults: std::sync::atomic::AtomicUsize::new(0),
                #[cfg(feature = "test-support")]
                refuse_reproject: std::sync::atomic::AtomicBool::new(false),
                #[cfg(test)]
                worker_read_hold: std::sync::Mutex::default(),
                #[cfg(any(test, feature = "test-support"))]
                archive_ack_hold: Mutex::default(),
                writer: Mutex::new(Some(handle)),
                repairs: Mutex::new(repairs),
                rebuilding,
                boot_steps,
            }),
        })
    }

    /// Whether this open owes a rebuild of the index (made anew now, or by an earlier start that did not finish it): its rows
    /// are being projected behind the serving core until [`Self::reconciled`] resolves.
    pub fn rebuilding(&self) -> bool {
        self.shared.rebuilding
    }

    /// Moves whenever the repairs owed at open move ([`Self::repairs`]): one ended, one was released, they stopped.
    pub fn repairs_changed(&self) -> tokio::sync::watch::Receiver<u64> {
        self.shared.gate.changes()
    }

    /// The steps of this open, each with when it ended, in order: for the boot's phase log.
    pub fn boot_steps(&self) -> Vec<(&'static str, Instant)> {
        self.shared.boot_steps.clone()
    }

    /// Resolves once every session owed a repair at open ([`owed_repairs`]) is ready, the ones held for a sensitive
    /// rewrite included: `Ok` when none failed, else the failure of one that did. It is the gate's verdict on
    /// [`Need::All`], waited for with no read: every read whose answer is about the set of sessions takes the same verdict
    /// with its snapshot, and a read that names sessions takes it on those alone.
    ///
    /// The repairs run on threads of their own: the sessions an access waits for and what they need first, then the
    /// worker candidates, then the rest. They start once this start's withheld set is committed ([`Self::withhold`]), or,
    /// for a store opened with [`RepairStart::FirstWait`], at the first access that waits for one, this one included. A
    /// repair that fails is not tried again in this start: every access that rests on its session fails with
    /// [`DbError::Recovery`], and what the session is owed stays in the index for the next start.
    pub fn reconciled(&self) -> impl Future<Output = Result<(), DbError>> + Send + 'static {
        let settled = self.shared.gate.settled(Need::All);
        async move { Ok(settled.await?) }
    }

    /// Where the repairs owed at open stand.
    pub fn repairs(&self) -> RepairReport {
        self.shared.gate.report()
    }

    /// The number of reads and writes that waited for a session's repair so far.
    #[cfg(test)]
    pub(crate) fn reconcile_waiters(&self) -> watch::Receiver<usize> {
        self.shared.gate.waiters()
    }

    /// The gate's verdict on the worker rows ([`Need::Workers`]), with no read.
    #[cfg(test)]
    pub(crate) fn worker_rows_projected(&self) -> impl Future<Output = Result<(), DbError>> + Send + 'static {
        let settled = self.shared.gate.settled(Need::Workers);
        async move { Ok(settled.await?) }
    }

    /// Resolves once no repair is queued or running; what is held for a rewrite or failed stays so, and certifies nothing.
    #[cfg(test)]
    pub(crate) async fn repairs_idle(&self) {
        let mut changes = self.shared.gate.changes();
        while self.shared.gate.report().pending != 0 {
            changes.changed().await.expect("the gate lives");
        }
    }

    /// The sessions repaired so far, in the order their repairs ended.
    #[cfg(test)]
    pub(crate) fn repair_order(&self) -> Vec<String> {
        self.shared.gate.order()
    }

    /// The sessions the repair threads took so far, in the order they were handed out: a rebuild repairs on several
    /// threads, so the order repairs end in is not the order they were given.
    #[cfg(test)]
    pub(crate) fn repair_taken(&self) -> Vec<String> {
        self.shared.gate.taken()
    }

    /// The writer stops at once (what is queued behind the close is dropped, its waiters answered `Stopped`) and its connection
    /// closes, and the read pool's idle connections close, so the database files can be removed while other handles still exist
    /// (a test's teardown; the exec's private root after its core stopped). Returns once the writer thread has ended.
    pub fn close(&self) {
        self.shared.gate.close(|| {
            let handle = self.shared.writer.lock().expect("writer handle").take();
            if let Some(handle) = handle {
                let _ = handle.join();
            }
        });
        // After the pool closed: a repair in flight fails its next step, and its thread holds no file of the data dir on.
        let repairs = std::mem::take(&mut *self.shared.repairs.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
        for repairs in repairs {
            let _ = repairs.join();
        }
    }

    /// Connects the sink of the catalog row writes. Set once; the second call is refused.
    pub fn observe_rows(&self, sink: Arc<dyn RowSink>) -> Result<(), &'static str> {
        self.shared.rows.set(sink).map_err(|_| "the row sink is already set")
    }

    /// A writer request that concerns no session in particular: sent at once.
    async fn ask(&self, make: impl FnOnce(Ack) -> Command) -> Result<(), DbError> {
        self.shared.gate.ask(&[], make).await
    }

    /// A writer request that concerns `session`: sent once its repair, when it is owed one, ended.
    async fn ask_of(&self, session: &str, make: impl FnOnce(Ack) -> Command) -> Result<(), DbError> {
        self.shared.gate.ask(&[session], make).await
    }

    /// Binds the archive authority's snapshot ([`crate::archive_state::ArchiveStates::bind_index`]). Set once.
    pub fn bind_archive(&self, view: crate::archive_state::ArchiveView) -> Result<(), &'static str> {
        self.shared.archive.set(view).map_err(|_| "the archive authority is already bound")
    }

    /// The archive snapshot the listings resolve through; none before the authority is bound.
    pub(crate) fn archive_snapshot(&self) -> Option<Arc<ArchiveSnapshot>> {
        bound_archive(&self.shared.archive)
    }

    /// The rows of `sessions` take their archive entries as the authority holds them when the writer gets to them; each row that
    /// changed is told to the row sink. Resolves once committed. The sessions a failed projection left owed go with it. A debt is
    /// settled only by a projection that read its state after the failure was noted (its read sequence is past the debt's), so an
    /// older projection answered late never clears a newer failure; a failure leaves every one of them owed.
    pub async fn project_archive(&self, sessions: Vec<String>) -> Result<(), DbError> {
        let mut seen = HashSet::new();
        let mut all: Vec<String> = self.owed().keys().cloned().collect();
        seen.extend(all.iter().cloned());
        all.extend(sessions.into_iter().filter(|id| seen.insert(id.clone())));
        if all.is_empty() {
            return Ok(());
        }
        let read = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let projected = self.project_archive_once(all, read.clone()).await;
        #[cfg(any(test, feature = "test-support"))]
        {
            let held = self.shared.archive_ack_hold.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
            if let Some((arrived, go)) = held {
                let _ = arrived.send(());
                let _ = go.await;
            }
        }
        let mut owed = self.owed();
        match &projected {
            Ok(()) => {
                let read = read.load(std::sync::atomic::Ordering::SeqCst);
                owed.retain(|id, debt| !(seen.contains(id) && *debt < read));
            }
            Err(_) => {
                raise_debts(&mut owed, seen, self.shared.archive_reads.load(std::sync::atomic::Ordering::SeqCst));
            }
        }
        projected
    }

    /// Records `sessions` as owed a projection without waiting for the writer: [`search`](Self::search) and the next
    /// [`project_archive`](Self::project_archive) settle them.
    pub fn owe_archive(&self, sessions: Vec<String>) {
        raise_debts(&mut self.owed(), sessions, self.shared.archive_reads.load(std::sync::atomic::Ordering::SeqCst));
    }

    fn owed(&self) -> std::sync::MutexGuard<'_, HashMap<String, u64>> {
        self.shared.archive_owed.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    async fn project_archive_once(&self, sessions: Vec<String>, read: Arc<std::sync::atomic::AtomicU64>) -> Result<(), DbError> {
        #[cfg(any(test, feature = "test-support"))]
        if self.shared.archive_faults.try_update(std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst, |n| n.checked_sub(1)).is_ok() {
            return Err(DbError::Write("the test's injected archive projection failure".into()));
        }
        self.ask(|ack| Command::Archive { sessions, read, ack }).await
    }

    /// The next archive projection holds its bookkeeping once its write answered (a test's): `.0` tells it arrived, `.1` lets it go.
    #[cfg(any(test, feature = "test-support"))]
    pub fn hold_archive_ack(&self) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (arrived_tx, arrived) = oneshot::channel();
        let (go, go_rx) = oneshot::channel();
        *self.shared.archive_ack_hold.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((arrived_tx, go_rx));
        (arrived, go)
    }

    /// The next `n` archive projections fail (a test's).
    #[cfg(any(test, feature = "test-support"))]
    pub fn fail_archive_projections(&self, n: usize) {
        self.shared.archive_faults.store(n, std::sync::atomic::Ordering::SeqCst);
    }

    /// Whether a failed archive projection is still owed.
    pub fn archive_owed(&self) -> bool {
        !self.owed().is_empty()
    }

    /// Catalog row write, coalesced per session; resolves once committed.
    /// The row is built by `summary::catalog_row` from `head` and the session's projected
    /// message state when it is written.
    pub async fn upsert(&self, head: CatalogHead, dirty: DirtyMark) -> Result<(), DbError> {
        let session = head.session.clone();
        self.ask_of(&session, |ack| Command::Upsert { head: Arc::new(head), dirty, ack: Some(ack) }).await
    }

    /// RL §9.2 rule 1: committed before the activation's first append. An error when the index holds no row of `session`
    /// for the log `log_id`: nothing is marked, and nothing may be appended.
    /// The mark names `activation` ([`new_activation`]), in the same transaction: only the retirement of that activation
    /// clears it, whichever process marked the session meanwhile.
    pub async fn mark_dirty(&self, session: &str, log_id: &str, activation: u64) -> Result<(), DbError> {
        let (id, log_id) = (session.to_owned(), log_id.to_owned());
        self.ask_of(session, |ack| Command::MarkDirty { session: id, log_id, activation, ack }).await
    }

    /// The last projection of a journal writer that closed cleanly (`LogWriter::close`): `projection` holds the frame the
    /// close appended, or none, and the session's final head. Queued in the order of the session's projections; the wait
    /// resolves `Ok` once the session's row is committed clean, in one transaction with the row, which is only when the
    /// index holds the log `retirement` names through its end (every projection before it, and the fork view the row is
    /// built from). Otherwise the mark stays, the row is written as any other, and the wait resolves with the reason.
    pub async fn queue_retirement(&self, projection: Projection, retirement: Retirement) -> Result<Committed, DbError> {
        let session = projection.session.clone();
        let answer = self.shared.gate.queue(&[&session], |ack| Command::Retire { projection, retirement, ack }).await?;
        Ok(Box::pin(gate::answered(answer)))
    }

    pub async fn set_status(&self, session: &str, status: SessionStatus, damage: Option<String>) -> Result<(), DbError> {
        let id = session.to_owned();
        self.ask_of(session, |ack| Command::Status { session: id, status, damage, ack }).await
    }

    pub async fn mark_deleted(&self, session: &str) -> Result<(), DbError> {
        let id = session.to_owned();
        self.ask_of(session, |ack| Command::Delete { session: id, ack }).await
    }

    /// The projection of a barrier; resolves when every frame is committed, and the session's catalog row with them (built from
    /// this head or a newer one; a fork whose inherited state is still being computed keeps its row until that is done).
    pub async fn project(&self, projection: Projection) -> Result<(), DbError> {
        let session = projection.session.clone();
        self.ask_of(&session, |ack| Command::Project { projection, ack: Some(ack) }).await
    }

    /// [`project`](Self::project) in two steps: resolves once the projection is queued at the writer, with the wait until every
    /// frame and the session's row are committed. The writer applies projections in the order they were queued, and a transaction
    /// takes every one queued when it starts, within its bounds.
    pub async fn queue_projection(&self, projection: Projection) -> Result<Committed, DbError> {
        let session = projection.session.clone();
        let answer = self.shared.gate.queue(&[&session], |ack| Command::Project { projection, ack: Some(ack) }).await?;
        Ok(Box::pin(gate::answered(answer)))
    }

    /// The rows of `session` (under `<data>/sessions`) rebuilt from its rewritten log, the replaced rows overwritten in
    /// the database and gone from the WAL; resolves once that is done.
    pub async fn reproject(&self, rewrite: Rewritten) -> Result<(), DbError> {
        #[cfg(feature = "test-support")]
        if self.shared.refuse_reproject.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return Err(DbError::Write("the test's injected rewrite projection failure".into()));
        }
        // The rewriter's own work on a session it may hold: it goes to the writer by the private way and waits at no gate
        // (the session is not ready before this and its release are done). The log is decoded in this lane job, and the
        // writer applies what it reads a transaction at a time, behind the serving core's writes.
        let (pool, sender) = self.shared.gate.private();
        pool.run_in_lane(move |_, _| replay_rewritten(&sender, &rewrite).map_err(DbError::Write)).await
    }

    /// Refuse the next request to replace a rewritten session's rows.
    #[cfg(feature = "test-support")]
    pub fn refuse_next_reproject(&self) {
        self.shared.refuse_reproject.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// The UI language changed: placeholder titles refold in maintenance steps.
    pub async fn set_placeholder_labels(&self, labels: PlaceholderLabels) -> Result<(), DbError> {
        self.ask(|ack| Command::Labels { labels, ack }).await
    }

    /// The gated read of this store ([`gate::Gate::read_exact`]): each method names what its answer rests on, and no
    /// caller chooses it.
    fn read<T: Send + 'static>(
        &self,
        need: Need,
        f: impl FnOnce(&Connection) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, DbError>> + Send + 'static {
        let read = self.shared.gate.read_exact(need, f);
        async move { Ok(read.await?) }
    }

    /// A read over `lineage`: a fork is ready only with the bases it reads.
    fn read_lineage<T: Send + 'static>(
        &self,
        lineage: Vec<LineageLevel>,
        f: impl FnOnce(&Connection, &[LineageLevel]) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, DbError>> + Send + 'static {
        self.read(Need::of(&levels(&lineage)), move |c| f(c, &lineage))
    }

    /// A read of `sessions` by name.
    fn read_of<T: Send + 'static>(
        &self,
        sessions: &[&str],
        f: impl FnOnce(&Connection) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, DbError>> + Send + 'static {
        self.read(Need::of(sessions), f)
    }

    /// [`read_of`](Self::read_of) on the calling thread, for code already inside a lane job: the same verdict.
    fn with_of<T>(&self, sessions: &[&str], f: impl FnOnce(&Connection) -> Result<T, DbError>) -> Result<T, DbError> {
        Ok(self.shared.gate.with_exact(&Need::of(sessions), f)?)
    }

    /// What the next start would have to repair if the process ended now ([`owed_repairs`]): the marked sessions and those
    /// whose rows hold frames past their cursor, in id order. Empty: the next start repairs nothing. The debts themselves,
    /// not a projection: read as they stand.
    pub async fn owed_repairs(&self) -> Result<Vec<String>, DbError> {
        self.shared.gate.manifest(|c| Ok(owed_repairs(c)?)).await
    }

    /// RL §9.2 rule 5.
    pub async fn dirty_sessions(&self) -> Result<Vec<String>, DbError> {
        self.read(Need::All, |c| {
            let mut stmt = c.prepare_cached("SELECT id FROM sessions WHERE dirty = 1")?;
            let rows = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .await
    }

    /// The next frame to project.
    pub async fn projected(&self, session: &str) -> Result<Option<FramePos>, DbError> {
        let id = session.to_owned();
        self.read_of(&[session], move |c| projected_on(c, &id)).await
    }

    /// Whether the projection has reached this exact durable log end, including its identity.
    pub fn history_projected_through_on_lane(&self, _lane: &InLane<InteractiveIo>, session: &str, log_id: &str, end: FramePos) -> Result<bool, DbError> {
        self.with_of(&[session], |c| {
            Ok(c.prepare_cached(
                "SELECT EXISTS (SELECT 1 FROM sessions WHERE id = ?1 AND log_id = ?2
             AND projected_ordinal = ?3 AND projected_file_no = ?4 AND projected_offset = ?5)",
            )?
            .query_row(params![session, log_id, end.ordinal as i64, end.file_no, end.offset as i64], |r| r.get(0))?)
        })
    }

    /// The session's prompt history (`OpenedLog.prompts`): the newest 50 distinct prompts
    /// of its lineage, newest first: its own (`prompt_history`), then each base's below
    /// the fork point and `cut`, live as of the fork (as history pages). Inside the open's
    /// J2 job on the read lane.
    pub fn prompts_on_lane(&self, _lane: &InLane<InteractiveIo>, lineage: &[LineageLevel], cut: Option<u64>) -> Result<Vec<String>, DbError> {
        self.with_of(&levels(lineage), |c| {
            let mut seen = std::collections::HashSet::new();
            let mut out = Vec::new();
            let mut own = c.prepare_cached(PROMPTS_SQL)?;
            let mut rows = own.query(params![lineage[0].session, PROMPT_HISTORY_LIMIT as i64])?;
            while let Some(r) = rows.next()? {
                let (key, text): (String, String) = (r.get(0)?, r.get(1)?);
                if seen.insert(key) {
                    out.push(text);
                }
            }
            for level in &lineage[1..] {
                if out.len() >= PROMPT_HISTORY_LIMIT {
                    break;
                }
                let end = level.end.unwrap_or(u64::MAX);
                let before = cut.map_or(end, |c| c.min(end));
                let mut stmt = c.prepare_cached(BASE_PROMPTS_SQL)?;
                let mut rows = stmt.query(params![level.session, before.min(i64::MAX as u64) as i64, end.min(i64::MAX as u64) as i64])?;
                while out.len() < PROMPT_HISTORY_LIMIT
                    && let Some(r) = rows.next()?
                {
                    let (key, text): (String, String) = (r.get(0)?, r.get(1)?);
                    if seen.insert(key) {
                        out.push(text);
                    }
                }
            }
            Ok(out)
        })
    }

    /// P §9.2 thread-scope lookup: the indexed op of `session` (records not yet projected
    /// are the session actor's to check).
    pub async fn thread_op(&self, session: &str, op_id: &str) -> Result<Option<ThreadOp>, DbError> {
        let (id, op_id) = (session.to_owned(), op_id.to_owned());
        self.read_of(&[session], move |c| thread_op_on(c, &id, &op_id)).await
    }

    /// The receipt of submission `submission` of `session` as projected so far ([`Self::submission_on_lane`]).
    pub async fn submission(&self, session: &str, submission: &str) -> Result<Option<serde_json::Value>, DbError> {
        let (id, submission) = (session.to_owned(), submission.to_owned());
        self.read_of(&[session], move |c| submission_on(c, &id, &submission)).await
    }

    /// `thread_op` inside a job already on the read lane: answered on the job's thread, so the job never waits for a lane slot
    /// behind itself.
    pub fn thread_op_on_lane(&self, _lane: &InLane<InteractiveIo>, session: &str, op_id: &str) -> Result<Option<ThreadOp>, DbError> {
        self.with_of(&[session], |c| thread_op_on(c, session, op_id))
    }

    /// The answer the first acceptance of submission `submission` of `session` got (`submissions`), on the read lane.
    pub fn submission_on_lane(&self, _lane: &InLane<InteractiveIo>, session: &str, submission: &str) -> Result<Option<serde_json::Value>, DbError> {
        self.with_of(&[session], |c| submission_on(c, session, submission))
    }

    /// The ops of `session` that `op/status{fence}` fenced (P §9.4): an actor refuses them at
    /// load, so a fence survives a reload.
    pub async fn fenced_ops(&self, session: &str) -> Result<Vec<String>, DbError> {
        let id = session.to_owned();
        self.read_of(&[session], move |c| fenced_ops_on(c, &id)).await
    }

    /// `fenced_ops` inside a job already on the read lane.
    pub fn fenced_ops_on_lane(&self, _lane: &InLane<InteractiveIo>, session: &str) -> Result<Vec<String>, DbError> {
        self.with_of(&[session], |c| fenced_ops_on(c, session))
    }

    /// The compaction dividers of the display history placed before rows of
    /// `lineage[level]` with ordinals in `[from, to)` (a page's span, `to` exclusive;
    /// `u64::MAX` for the newest page), in display order. Each live `compacted` frame of the
    /// lineage is one divider (1.4.5's "Conversation compacted" row), shown immediately
    /// before the first displayed row of `lineage[level]` with ordinal ≥ `boundary`: the
    /// oldest message row its replacement kept, wherever the lineage holds it (a fork keeps
    /// rows it inherited: 1.4.5 restores the fork's own copy of them after the divider), else
    /// the end of the rows before the compaction. A compaction a rewind or `clear`
    /// superseded has none. Finding an inherited kept row costs one indexed lookup per
    /// replacement entry and deeper level, on the read lane.
    pub async fn dividers(&self, lineage: Vec<LineageLevel>, cut: Option<u64>, level: usize, from: u64, to: u64) -> Result<Vec<Divider>, DbError> {
        self.read_lineage(lineage, move |c, lineage| dividers_on(c, lineage, cut, level, from, to)).await
    }

    /// `dividers` inside a job already on the read lane.
    pub fn dividers_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        level: usize,
        from: u64,
        to: u64,
    ) -> Result<Vec<Divider>, DbError> {
        self.with_of(&levels(lineage), |c| counted(c, lineage, |c| dividers_on(c, lineage, cut, level, from, to)))
    }

    /// The JSON list row of a session; `None` for a session whose log has no readable
    /// `session` frame (1.4.5 reads such a file as no session) or that was deleted.
    pub async fn summary(&self, session: &str) -> Result<Option<String>, DbError> {
        let id = session.to_owned();
        let found: Option<(String, bool)> = self
            .read_of(&[session], move |c| {
                Ok(c.prepare_cached(&format!("SELECT summary, {WITHHELD_COL} FROM sessions WHERE id = ?1 AND log_id <> '' AND deleted = 0"))?
                    .query_row([&id], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()?)
            })
            .await?;
        Ok(found.map(|(summary, withheld)| if withheld { withheld::blank_summary(&summary) } else { summary }))
    }

    /// The header members a listing reads of a session (`worker::LISTED_FIELDS`), from its catalog row. The outer `None`:
    /// the index cannot answer for the session (no row, a row behind its log, or a deleted one) and its record is the
    /// source; the inner `None`: a session kept only to host a worker row. A session whose repair is owed and not done
    /// (or failed) is one the index cannot answer for, as a marked one: a listing does not wait for it.
    pub async fn listed(&self, session: &str) -> Result<Option<Option<String>>, DbError> {
        // Read before the row: a session repaired in between is answered as not answerable, never from the row before.
        if self.shared.gate.unavailable().contains(session) {
            return Ok(None);
        }
        let sessions = vec![session.to_owned()];
        Ok(self.shared.gate.manifest(move |c| listed_on(c, &sessions)).await?.pop().flatten())
    }

    /// [`listed`](Self::listed) of every session of a listing, in order and in one read, on the calling thread (a job of
    /// the read lane): a listing names hundreds of sessions, and a read each filled the lane's queue. The caller queues
    /// the one job, so a full queue is waited out there and never answered as "the index cannot say".
    pub fn listed_many(&self, _lane: &InLane<InteractiveIo>, sessions: &[String]) -> Result<Vec<Option<Option<String>>>, DbError> {
        let unavailable = self.shared.gate.unavailable();
        let mut listed = self.shared.gate.manifest_here(|c| listed_on(c, sessions))?;
        for (session, row) in sessions.iter().zip(&mut listed) {
            if unavailable.contains(session) {
                *row = None;
            }
        }
        Ok(listed)
    }

    /// What the index knows of the sessions that may name the sidecars of session `own` (no session log is opened):
    /// the sessions whose reference set names it, in id order, a deleted one and `own` left out; the first session it
    /// holds as not readable (`status` other than `ok`); a copy whose set names it that the process of boot `boot` is
    /// still making; and every other listed session whose set is unknown (its header holds none and no scan of its
    /// transcript is current), with the ordinal it is projected to.
    pub async fn offload_referencers(&self, own: &str, boot: &str) -> Result<OffloadReferencers, DbError> {
        // It decides from every session's row: a row not yet repaired may lack a reference its log holds.
        let (own, boot) = (own.to_owned(), boot.to_owned());
        let segment = crate::offload_sources::segment_key(&crate::offload_sources::safe_segment(&own));
        self.read(Need::All, move |c| {
            let unreadable: Option<String> =
                c.prepare_cached("SELECT id FROM sessions WHERE deleted = 0 AND status <> 'ok' ORDER BY id LIMIT 1")?.query_row([], |r| r.get(0)).optional()?;
            let mut rows = c.prepare_cached(
                "SELECT r.session FROM offload_refs r LEFT JOIN sessions s ON s.id = r.session
                 WHERE r.source = ?1 AND r.session <> ?2 AND coalesce(s.deleted, 0) = 0 ORDER BY r.session",
            )?;
            let sessions = rows.query_map(params![segment, own], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            let copying = c
                .prepare_cached(
                    "SELECT m.session, m.source FROM offload_marks m JOIN offload_refs r ON r.session = m.session AND r.source = ?1
                     WHERE m.boot = ?2 AND m.session <> ?3 ORDER BY m.session LIMIT 1",
                )?
                .query_row(params![segment, boot, own], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .optional()?;
            let mut rows = c.prepare_cached(
                "SELECT s.id, s.projected_ordinal FROM sessions s LEFT JOIN offload_known k ON k.session = s.id
                 WHERE s.deleted = 0 AND s.status = 'ok' AND s.log_id <> '' AND s.id <> ?1
                   AND (k.session IS NULL OR k.rules <> ?2 OR (k.ordinal IS NOT NULL AND k.ordinal <> s.projected_ordinal)
                        OR (k.ordinal IS NOT NULL AND EXISTS (SELECT 1 FROM meta m WHERE m.key = 'hole:' || s.id)))
                 ORDER BY s.id",
            )?;
            let unknown = rows
                .query_map(params![own, crate::offload_sources::RULES], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(OffloadReferencers { sessions, unreadable, copying, unknown })
        })
        .await
    }

    /// Stores what a scan of the transcript of `session` (a session whose header holds no set) at `ordinal` names
    /// (`record_offload_scan`).
    pub async fn record_offload_scan(&self, session: &str, ordinal: i64, sources: Vec<String>) -> Result<(), DbError> {
        let id = session.to_owned();
        self.ask_of(session, |ack| Command::OffloadScan { session: id, ordinal, sources, ack }).await
    }

    /// The raw header `title` of a session (1.4.5 `readStoredSessionMetadata`'s
    /// `session.title || null`); `None` when it has none, is not listed or was deleted.
    pub async fn title(&self, session: &str) -> Result<Option<String>, DbError> {
        let id = session.to_owned();
        self.read_of(&[session], move |c| {
            Ok(c.prepare_cached(
                "SELECT title FROM sessions WHERE id = ?1 AND log_id <> '' AND deleted = 0
                 AND NOT EXISTS (SELECT 1 FROM withheld_sessions w WHERE w.id = sessions.id)",
            )?
            .query_row([&id], |r| r.get(0))
            .optional()?
            .flatten())
        })
        .await
    }

    /// The sessions not deleted whose header carries `child`'s archived result (`archived_agents`). A lookup from the
    /// child to its parents: any session may be one, so an empty answer is one only with every session owed its rows
    /// projected, and the failure of one of them is the answer instead.
    pub async fn archived_agent_parents(&self, child: &str) -> Result<Vec<String>, DbError> {
        let child = child.to_owned();
        self.read(Need::All, move |c| {
            let mut stmt = c.prepare_cached(
                "SELECT a.session FROM archived_agents a JOIN sessions s ON s.id = a.session
                 WHERE a.child = ?1 AND s.deleted = 0 AND s.log_id <> '' ORDER BY a.session",
            )?;
            let rows = stmt.query_map([&child], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
    }

    /// Whether the session was deleted (its header's delete mark, or `mark_deleted`);
    /// `None` for a session the index does not hold (never created, or purged).
    pub async fn deleted(&self, session: &str) -> Result<Option<bool>, DbError> {
        let id = session.to_owned();
        self.read_of(&[session], move |c| Ok(c.prepare_cached("SELECT deleted FROM sessions WHERE id = ?1")?.query_row([&id], |r| r.get(0)).optional()?)).await
    }

    /// Every session the index holds as deleted, in one read ([`deleted`](Self::deleted) for all of them).
    pub async fn deleted_ids(&self) -> Result<std::collections::HashSet<String>, DbError> {
        self.read(Need::All, move |c| {
            let mut stmt = c.prepare_cached("SELECT id FROM sessions WHERE deleted = 1")?;
            Ok(stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)
        })
        .await
    }

    /// The purge the boot defers while projections are owed ([`Writer::boot_purge`]): it waits for the gate's verdict on
    /// every session ([`Need::All`]) and then purges as any other does, each removal decided again on a certified read. A
    /// failed repair defers it to the next start (`Err` with that failure): nothing is removed.
    pub async fn purge_once_projected(&self, lane: MaintenanceIo, data: PathBuf) -> Result<Vec<String>, DbError> {
        self.shared.gate.settled(Need::All).await?;
        self.purge_deleted(lane, data).await
    }

    /// Whether a session owed its rows at open is not ready: queued, running, held for its rewrite, or failed. While
    /// one is, a missing fork edge or reference proves nothing, and nothing is removed for the lack of one.
    pub fn owes_projection(&self) -> bool {
        !matches!(self.shared.gate.settled_now(&Need::All), Ok(true))
    }

    /// Removes the files and index rows of every deleted session no live thread's lineage
    /// reads, and returns their ids in removal order. A deleted session that is a fork base
    /// stays while any session forked from it (at any depth) is not deleted: the fork reads
    /// its base's logs. Each removal unlinks the first log file (a rebuild then no longer
    /// sees the folder), then the folder, on the maintenance lane; then the writer drops the
    /// index rows in maintenance steps of `STEP_ROWS` rows, the catalog row last. A base whose
    /// last fork went is removed in the same call. Run it after a delete; `open` runs the
    /// same purge at boot, so an interrupted removal resumes.
    pub async fn purge_deleted(&self, lane: MaintenanceIo, data: PathBuf) -> Result<Vec<String>, DbError> {
        let mut purged = Vec::new();
        // As at boot ([`Writer::boot_purge`]): that no fork reads a deleted session is known only with every session's
        // fork edge in. Until then (and for good in a start in which a repair failed) it is deferred, never concluded: a
        // later purge (the next delete's, the deferred one, or the next start's) removes what this leaves.
        if self.owes_projection() {
            return Ok(purged);
        }
        loop {
            // A session owing its sensitive rewrite is not removed while its rewrite may be moving its folder
            // (`PURGEABLE_ALL_SQL` leaves it out): a later purge (the next delete's, or the next start's) removes it once
            // it is released. Each removal is decided on its own certified read of every session.
            let found = self.read(Need::All, move |c| Ok(c.prepare_cached(PURGEABLE_ALL_SQL)?.query_row([], |r| r.get::<_, String>(0)).optional()?));
            let Some(session) = found.await? else { return Ok(purged) };
            let dir = data.join("sessions").join(&session);
            lane.submit_wait(&CancellationToken::new(), move |lane| remove_session_dir(lane, &dir)).await.map_err(lane_unrun)?.await.map_err(lane_lost)??;
            let id = session.clone();
            self.ask_of(&session, |ack| Command::Purge { session: id, ack }).await?;
            purged.push(session);
        }
    }

    /// The worker rows (FORMAT.md §8.2 worker index) in `scope`, of tag `tag` when given
    /// (a cleaned tag; '' finds the rows without one), newest session first.
    pub async fn worker_rows(&self, tag: Option<&str>, scope: WorkerScope) -> Result<Vec<WorkerRow>, DbError> {
        let tag = tag.map(str::to_owned);
        self.read(Need::Workers, move |c| {
            let sql = crate::worker::ROWS_SQL[usize::from(tag.is_some())][match scope {
                WorkerScope::Owner(_) => 0,
                WorkerScope::HostPid(_) => 1,
                WorkerScope::All => 2,
            }];
            let mut args: Vec<rusqlite::types::Value> = Vec::with_capacity(2);
            match scope {
                WorkerScope::Owner(owner) => args.push(owner.into()),
                WorkerScope::HostPid(pid) => args.push(pid.into()),
                WorkerScope::All => {}
            }
            args.extend(tag.map(rusqlite::types::Value::from));
            let mut stmt = c.prepare_cached(sql)?;
            // The row and its withheld state are one statement (`rows_sql!`'s fourth column).
            let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| {
                let mut worker = serde_json::from_str(r.get_ref(1)?.as_str()?)
                    .map_err(|e| rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(e)))?;
                let mut summary: String = r.get(2)?;
                if r.get::<_, bool>(3)? {
                    withheld::keep_structural(&mut worker);
                    summary = withheld::blank_summary(&summary);
                }
                Ok(WorkerRow { session: r.get(0)?, worker, summary })
            })?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
        .await
    }

    /// The worker index the agent registry loads, from the revision it holds (`None`: none yet): the revision now and
    /// every session written since, with the sessions in `also` read again whatever their revision; every listed session
    /// when `since` is `None` or a revision this index never reached. The revision and the rows are one read transaction,
    /// so they are one committed state, whichever connection or process wrote it (FORMAT.md §8.2 worker index revision).
    ///
    /// A row's withheld state is a column of the statement that reads it, in the same read transaction as the revision:
    /// a release commits the cleared state and the moved revision together, so a load sees a row blank at the revision
    /// before the release or in full at the one after, never blank at the later one.
    pub async fn worker_index_since(&self, since: Option<(u64, u64)>, also: Vec<String>) -> Result<crate::worker::WorkerIndexRead, DbError> {
        #[cfg(test)]
        let hold = self.shared.worker_read_hold.lock().expect("hold").take();
        self.read(Need::Workers, move |c| {
            let own = read_snapshot(c)?;
            let tx: &Connection = own.as_deref().unwrap_or(c);
            let (revision, floor, generation) =
                tx.query_row(crate::worker::REVISION_SQL, [], |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64)))?;
            let full = since.is_none_or(|(held, rev)| held != generation || rev > revision || rev < floor);
            let sessions = if full {
                let mut stmt = tx.prepare_cached(crate::worker::INDEXED_ALL_SQL)?;
                stmt.query_map([], indexed_session)?.collect::<Result<_, _>>()?
            } else {
                indexed_since(tx, since.map_or(0, |(_, rev)| rev) as i64, also)?
            };
            #[cfg(test)]
            if let Some(hold) = hold {
                hold();
            }
            Ok(crate::worker::WorkerIndexRead { revision, generation, full, sessions })
        })
        .await
    }

    /// Test support: the index row of `session`'s op `op_id` removed, as a projection the index never took leaves it. Written
    /// by the index writer, in order with its appends. Refused when there is no such row.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn forget_thread_op(&self, session: &str, op_id: &str) -> Result<(), DbError> {
        let (id, op_id) = (session.to_owned(), op_id.to_owned());
        self.ask_of(session, |ack| Command::ForgetThreadOp { session: id, op_id, ack }).await
    }

    /// Test support: `session`'s `worker` map replaced (`None`: removed) by a connection of its own, committed as another
    /// process writing the index would.
    #[cfg(any(test, feature = "test-support"))]
    pub fn set_worker_elsewhere(&self, session: &str, worker: Option<&serde_json::Map<String, serde_json::Value>>) {
        let mut header = serde_json::Map::new();
        if let Some(map) = worker {
            header.insert("worker".into(), serde_json::Value::Object(map.clone()));
        }
        let keys = crate::worker::WorkerKeys::of(&header);
        let conn = Connection::open(&self.shared.path).expect("the index opens");
        conn.execute(
            "UPDATE sessions SET worker = ?1, worker_tag = ?2, worker_owner = ?3, worker_host_pid = ?4 WHERE id = ?5",
            params![
                keys.as_ref().map(|k| &k.map),
                keys.as_ref().map(|k| &k.tag),
                keys.as_ref().and_then(|k| k.owner.as_ref()),
                keys.as_ref().and_then(|k| k.host_pid),
                session
            ],
        )
        .expect("the other connection's write");
    }

    /// The newest session `owner` ran under `tag` (1.4.5 `lastTagSession`, open or closed),
    /// by the session's own `agentTag` (a cleaned tag) and owner.
    pub async fn newest_tag_session(&self, tag: &str, owner: &str) -> Result<Option<TagSession>, DbError> {
        let (tag, owner) = (tag.to_owned(), owner.to_owned());
        // Any session may carry the tag: "none ran under it" is an answer only over every session.
        self.read(Need::All, move |c| {
            Ok(c.prepare_cached(crate::worker::NEWEST_TAG_SQL)?
                .query_row([&tag, &owner], |r| {
                    let summary: String = r.get(1)?;
                    let summary = if r.get::<_, bool>(2)? { withheld::blank_summary(&summary) } else { summary };
                    Ok(TagSession { session: r.get(0)?, summary })
                })
                .optional()?)
        })
        .await
    }

    /// The list rows of the agent-only sessions (`visibility` 'agent-only'), the
    /// candidates of 1.4.5 agent rehydration; most recent activity first.
    pub async fn agent_only_sessions(&self) -> Result<Vec<String>, DbError> {
        self.read(Need::Workers, |c| {
            let mut stmt = c.prepare_cached(AGENT_ONLY_SQL)?;
            let rows = stmt.query_map([], |r| {
                let summary: String = r.get(0)?;
                Ok(if r.get::<_, bool>(1)? { withheld::blank_summary(&summary) } else { summary })
            })?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
        .await
    }

    /// Session search (FORMAT.md §8.2): summaries in result order.
    pub async fn search(&self, query: &str, limit: usize, after: Option<SearchCursor>) -> Result<Vec<String>, DbError> {
        // It filters and orders by the projected `archived` column: an owed projection is settled first, or the search fails.
        if self.archive_owed() {
            self.project_archive(Vec::new()).await?;
        }
        let (sql, arg, limit) = search_statement(query, limit);
        // A page of matches over every session: it waits for each one owed its rows, and a failed one fails it.
        self.read(Need::All, move |c| {
            let mut stmt = c.prepare_cached(&sql)?;
            let rows = stmt
                .query_map(
                    params![
                        arg,
                        limit as i64,
                        after.as_ref().map(|a| a.archived),
                        after.as_ref().map(|a| a.activity),
                        after.as_ref().map(|a| a.id_key.clone())
                    ],
                    |r| {
                        let summary: String = r.get(0)?;
                        Ok(if r.get::<_, bool>(1)? { withheld::blank_summary(&summary) } else { summary })
                    },
                )?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .await
    }

    /// One page of visible live history, newest first, across the fork lineage
    /// (`lineage[0]` is the session, then its bases). At most `limit` rows and
    /// `PAGE_MAX_BYTES` of frames (at least one row). `cut` is the session's
    /// `Fold::base_cut`: base rows at or above it are not part of its history.
    pub async fn history_page(
        &self,
        lineage: Vec<LineageLevel>,
        cut: Option<u64>,
        cursor: Option<PageCursor>,
        limit: usize,
    ) -> Result<(Vec<HistoryRow>, Option<PageCursor>), DbError> {
        self.read_lineage(lineage, move |c, lineage| page_on(c, lineage, cut, cursor, limit)).await
    }

    /// Step 1 of a model-context read (`crate::context`, FORMAT.md §6.4), inside a job on
    /// the read lane: the next page of the context of `lineage` (`lineage[0]` the thread,
    /// then its bases; `cut` its `Fold::base_cut`) from `cursor` (`None`: the start), at
    /// most `limit` rows and `PAGE_MAX_BYTES` of frames (at least one row), with its frames
    /// read from `sessions/<session>/` under `sessions`.
    pub fn context_page_on_lane(
        &self,
        lane: &InLane<InteractiveIo>,
        sessions: &Path,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        cursor: Option<crate::context::ContextCursor>,
        limit: usize,
    ) -> Result<crate::context::ContextPage, crate::context::ContextError> {
        let (rows, next) = self.with_of(&levels(lineage), |c| crate::context::rows_on(c, lineage, cut, cursor, limit))?;
        crate::context::read_frames(lane, sessions, rows, next)
    }

    /// How many messages the model context of `lineage` holds: the rows of [`Self::context_page_on_lane`], counted
    /// from the index alone (no frame is read or parsed), so asking for the length of a context costs one index scan
    /// instead of the context's bytes. A history that changes under the scan starts it again.
    pub fn context_len_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
    ) -> Result<usize, crate::context::ContextError> {
        const PAGE_ROWS: usize = 4096;
        'restart: loop {
            let (mut cursor, mut len) = (None, 0);
            loop {
                match self.with_of(&levels(lineage), |c| crate::context::rows_on(c, lineage, cut, cursor, PAGE_ROWS)) {
                    Ok((rows, next)) => {
                        len += rows.len();
                        match next {
                            Some(next) => cursor = Some(next),
                            None => return Ok(len),
                        }
                    }
                    Err(DbError::CursorStale) => continue 'restart,
                    Err(e) => return Err(e.into()),
                }
            }
        }
    }

    /// The page [`Self::context_page_on_lane`] would return for the rows from the `skip`th on (`skip` counted as in
    /// [`Self::context_len_on_lane`]), as one page: the index is scanned for every row, but only those rows' frames are read.
    /// A history that changes under the scan starts it again.
    pub fn context_page_from_on_lane(
        &self,
        lane: &InLane<InteractiveIo>,
        sessions: &Path,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        skip: usize,
    ) -> Result<crate::context::ContextPage, crate::context::ContextError> {
        const PAGE_ROWS: usize = 4096;
        let rows = 'restart: loop {
            let (mut cursor, mut seen, mut kept) = (None, 0usize, Vec::new());
            loop {
                match self.with_of(&levels(lineage), |c| crate::context::rows_on(c, lineage, cut, cursor, PAGE_ROWS)) {
                    Ok((rows, next)) => {
                        let before = seen;
                        seen += rows.len();
                        kept.extend(rows.into_iter().skip(skip.saturating_sub(before)));
                        match next {
                            Some(next) => cursor = Some(next),
                            None => break 'restart kept,
                        }
                    }
                    Err(DbError::CursorStale) => continue 'restart,
                    Err(e) => return Err(e.into()),
                }
            }
        };
        crate::context::read_frames(lane, sessions, rows, None)
    }

    /// `history_page` inside a job already on the read lane (the open's J2 window read).
    pub fn history_page_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        cursor: Option<PageCursor>,
        limit: usize,
    ) -> Result<(Vec<HistoryRow>, Option<PageCursor>), DbError> {
        self.with_of(&levels(lineage), |c| counted(c, lineage, |c| page_on(c, lineage, cut, cursor, limit)))
    }

    /// [`Self::history_page_on_lane`] the other way: the rows from `cursor` on (the lineage's oldest row when none), oldest
    /// first, and where the next newer page starts (`None`: these reach the newest row).
    pub fn history_page_after_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        cursor: Option<AfterCursor>,
        limit: usize,
    ) -> Result<(Vec<HistoryRow>, Option<AfterCursor>), DbError> {
        self.with_of(&levels(lineage), |c| counted(c, lineage, |c| page_after_on(c, lineage, cut, cursor, limit)))
    }

    /// One page of occurrences, newest first: the rows of [`Self::history_page_on_lane`] and, with `boundaries`, the
    /// boundary of each compaction that lists a divider, at the compaction's own ordinal among them (as first or last
    /// occurrence of the lineage, and one directly after another, alike). A boundary counts for `limit` as a row does.
    pub fn unit_page_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        cursor: Option<PageCursor>,
        limit: usize,
        boundaries: bool,
    ) -> Result<(Vec<UnitRow>, Option<PageCursor>), DbError> {
        self.with_of(&levels(lineage), |c| counted(c, lineage, |c| unit_page_on(c, lineage, cut, cursor, limit, boundaries)))
    }

    /// [`Self::unit_page_on_lane`] the other way: the occurrences from `cursor` on (the lineage's oldest when none),
    /// oldest first, and where the next newer page starts (`None`: these reach the newest occurrence).
    pub fn unit_page_after_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        cursor: Option<AfterCursor>,
        limit: usize,
        boundaries: bool,
    ) -> Result<(Vec<UnitRow>, Option<AfterCursor>), DbError> {
        self.with_of(&levels(lineage), |c| counted(c, lineage, |c| unit_page_after_on(c, lineage, cut, cursor, limit, boundaries)))
    }

    /// Where the occurrence a position names is: the row `ids` or `alias` name ([`Self::history_anchor_on_lane`]),
    /// else the boundary of the compaction `boundary` (its `cid`). The cursor reads back from the occurrence, itself
    /// first; one level and `before - 1` is where a read on from it starts.
    pub fn unit_anchor_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        ids: &[String],
        alias: &str,
        boundary: Option<&str>,
    ) -> Result<Option<HistoryAnchor>, DbError> {
        self.with_of(&levels(lineage), |c| counted(c, lineage, |c| unit_anchor_on(c, lineage, cut, ids, alias, boundary)))
    }

    /// [`Self::unit_page_on_lane`], as a job of the read pool.
    pub async fn unit_page(
        &self,
        lineage: Vec<LineageLevel>,
        cut: Option<u64>,
        cursor: Option<PageCursor>,
        limit: usize,
    ) -> Result<(Vec<UnitRow>, Option<PageCursor>), DbError> {
        self.read_lineage(lineage, move |c, lineage| unit_page_on(c, lineage, cut, cursor, limit, true)).await
    }

    /// [`Self::unit_page_after_on_lane`], as a job of the read pool.
    pub async fn unit_page_after(
        &self,
        lineage: Vec<LineageLevel>,
        cut: Option<u64>,
        cursor: Option<AfterCursor>,
        limit: usize,
    ) -> Result<(Vec<UnitRow>, Option<AfterCursor>), DbError> {
        self.read_lineage(lineage, move |c, lineage| unit_page_after_on(c, lineage, cut, cursor, limit, true)).await
    }

    /// [`Self::unit_anchor_on_lane`], as a job of the read pool.
    pub async fn unit_anchor(
        &self,
        lineage: Vec<LineageLevel>,
        cut: Option<u64>,
        ids: Vec<String>,
        boundary: Option<String>,
    ) -> Result<Option<HistoryAnchor>, DbError> {
        self.read_lineage(lineage, move |c, lineage| unit_anchor_on(c, lineage, cut, &ids, "", boundary.as_deref())).await
    }

    /// The stored result of each tool call of `calls` (`(ordinal of the record that shows the call, call id)`), oldest
    /// first: the first visible `tool` message after that record, in its turn, that answers the call, in the call's
    /// own log or a later level's. A call's result is a message of the call's turn, so the lookup walks that turn's
    /// model rows after the call by `history_turn`, however many records of other turns lie between; a call with no
    /// stored result has no row. A call of no turn is answered within its run of turn-less rows, which the first row
    /// of a turn after it ends.
    pub fn call_results_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        calls: &[(u64, String)],
    ) -> Result<Vec<HistoryRow>, DbError> {
        self.with_of(&levels(lineage), |c| counted(c, lineage, |c| call_results_on(c, lineage, cut, calls)))
    }

    /// `turn_messages_on` inside a job already on the read lane.
    pub fn turn_messages_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        turns: &[String],
    ) -> Result<Vec<(bool, bool)>, DbError> {
        self.with_of(&levels(lineage), |c| counted(c, lineage, |c| turn_messages_on(c, lineage, cut, turns)))
    }

    /// The history revision the index holds the rows of `lineage`'s thread at: the one its pages are of.
    pub fn history_rev_on_lane(&self, _lane: &InLane<InteractiveIo>, lineage: &[LineageLevel]) -> Result<u64, DbError> {
        self.with_of(&levels(lineage), |c| counted(c, lineage, |c| Ok(history_rev_on(c, lineage)?)))
    }

    /// `anchor_on`, as a job of the read pool.
    pub async fn history_anchor(
        &self,
        lineage: Vec<LineageLevel>,
        cut: Option<u64>,
        ids: Vec<String>,
        alias: String,
    ) -> Result<Option<HistoryAnchor>, DbError> {
        self.read_lineage(lineage, move |c, lineage| anchor_on(c, lineage, cut, &ids, &alias)).await
    }

    /// `anchor_on` inside a job already on the read lane.
    pub fn history_anchor_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        ids: &[String],
        alias: &str,
    ) -> Result<Option<HistoryAnchor>, DbError> {
        self.with_of(&levels(lineage), |c| counted(c, lineage, |c| anchor_on(c, lineage, cut, ids, alias)))
    }

    /// The live `compacted` frame whose replacement holds the entry `iid` (such as the
    /// summary, which has no history row), as the reader of `lineage` with `cut` sees it:
    /// its `ordinal` is that of a `model_switch` anchor on the entry (FORMAT.md §5.3). The
    /// newest such frame when later replacements kept the entry; `None` when no live one
    /// holds it.
    pub async fn compaction_entry(&self, lineage: Vec<LineageLevel>, cut: Option<u64>, iid: String) -> Result<Option<CompactionEntry>, DbError> {
        self.read_lineage(lineage, move |c, lineage| compaction_entry_on(c, lineage, cut, &iid)).await
    }

    /// `compaction_entry` inside a job already on the read lane.
    pub fn compaction_entry_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        iid: &str,
    ) -> Result<Option<CompactionEntry>, DbError> {
        self.with_of(&levels(lineage), |c| compaction_entry_on(c, lineage, cut, iid))
    }
}

/// The `compacted` frame holding a replacement entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionEntry {
    pub ordinal: u64,
    pub cid: String,
}

/// Newest level first: a session's own compactions follow its bases'.
fn compaction_entry_on(c: &Connection, lineage: &[LineageLevel], cut: Option<u64>, iid: &str) -> Result<Option<CompactionEntry>, DbError> {
    for (i, level) in lineage.iter().enumerate() {
        let asof = level.end.map_or(i64::MAX, |v| v.min(i64::MAX as u64) as i64);
        let bound = crate::archive_index::level_bound(lineage, cut, i);
        let found = c
            .prepare_cached(COMPACTION_ENTRY_SQL)?
            .query_row(params![level.session, iid, asof, bound], |r| Ok(CompactionEntry { ordinal: r.get::<_, i64>(0)? as u64, cid: r.get(1)? }))
            .optional()?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

/// The newest `compacted` frame of session `?1` below `?4`, live as of `?3`, with a
/// replacement entry `?2`.
pub(crate) const COMPACTION_ENTRY_SQL: &str = "SELECT m.ordinal, c.cid FROM message_rows m
     JOIN compactions c ON c.session = m.session AND c.ordinal = m.ordinal
     WHERE m.session = ?1 AND m.iid = ?2 AND m.ver = m.ordinal AND m.ordinal < ?4
       AND (c.superseded_rev IS NULL OR c.superseded_rev >= ?3)
     ORDER BY m.ordinal DESC LIMIT 1";

fn indexed_session(r: &rusqlite::Row<'_>) -> rusqlite::Result<crate::worker::IndexedSession> {
    let mut worker: Option<serde_json::Map<String, serde_json::Value>> = match r.get::<_, Option<String>>(2)? {
        Some(text) => Some(serde_json::from_str(&text).map_err(|e| rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e)))?),
        None => None,
    };
    let summary: Option<String> = r.get(4)?;
    let mut agent = match summary {
        Some(summary) => Some((r.get(3)?, summary)),
        None => None,
    };
    if r.get::<_, bool>(5)? {
        if let Some(worker) = worker.as_mut() {
            withheld::keep_structural(worker);
        }
        if let Some((_, summary)) = agent.as_mut() {
            *summary = withheld::blank_summary(summary);
        }
    }
    Ok(crate::worker::IndexedSession { session: r.get(0)?, created_at: r.get(1)?, worker, log_id: r.get(6)?, agent })
}

fn indexed_since(tx: &Connection, since: i64, also: Vec<String>) -> Result<Vec<crate::worker::IndexedSession>, DbError> {
    use crate::worker::IndexedSession;
    let mut sessions: Vec<IndexedSession> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    let mut put = |sessions: &mut Vec<IndexedSession>, s: IndexedSession| match at.get(&s.session) {
        Some(&i) => sessions[i] = s,
        None => {
            at.insert(s.session.clone(), sessions.len());
            sessions.push(s);
        }
    };
    let gone = |id: String| IndexedSession { session: id, created_at: None, worker: None, log_id: None, agent: None };
    let removed: Vec<String> = tx.prepare_cached(crate::worker::REMOVED_SINCE_SQL)?.query_map([since], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for id in removed {
        put(&mut sessions, gone(id));
    }
    let changed: Vec<IndexedSession> = tx.prepare_cached(crate::worker::INDEXED_SINCE_SQL)?.query_map([since], indexed_session)?.collect::<Result<_, _>>()?;
    for s in changed {
        put(&mut sessions, s);
    }
    for id in also {
        if sessions.iter().any(|s| s.session == id) {
            continue;
        }
        let found = tx.prepare_cached(crate::worker::INDEXED_ONE_SQL)?.query_row([&id], indexed_session).optional()?;
        put(&mut sessions, found.unwrap_or_else(|| gone(id)));
    }
    Ok(sessions)
}

/// The production `IndexProjector` of the migration (WP-MIGRATE `index.rs`): projects the
/// verified `sessions` of data dir `data` into a new index database at `db` (absent
/// before the call; closed, without WAL, after it). Each log is read forward from its
/// `session` frame and folded in memory, frames are written in the writer's bounded
/// transactions, and the catalog row (`summary::catalog_row`) is written clean.
/// A log that cannot be read to its end is a damaged session (FORMAT.md §3.4, §8.2): the
/// frames before the failure stay projected, and a log without a readable `session` frame
/// keeps only an unlisted row carrying its damage. Only an index write error fails the call.
/// Blocking: the migration runs it on its own thread before the runtime starts.
pub fn project_index(data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
    project_into(data, db, sessions, INDEX_DDL, None)
}

/// [`project_index`] with the DDL the new database is created by (the generation it sets), and the progress it reports.
fn project_into(data: &Path, db: &Path, sessions: &[String], ddl: &str, progress: Option<&RebuildProgress>) -> Result<(), String> {
    let mut conn = open_writer(db, Some(ddl)).map_err(|e| e.to_string())?;
    // The database is used only once it is whole (its caller flushes the file, then publishes it), so no commit before the
    // last has to outlive a power loss. Flushed at every commit, a quarter of a rebuild was the wait for the device.
    conn.pragma_update(None, "synchronous", "OFF").map_err(|e| e.to_string())?;
    let heads = project_sessions(&mut conn, data, sessions, progress)?;
    // Forks projected before their base wait on it: finish their views, then rebuild the
    // rows that were held back.
    loop {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let step = crate::message_index::view_step(&tx, STEP_ROWS).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        if step == crate::message_index::Step::Idle {
            break;
        }
    }
    let labels = PlaceholderLabels::default();
    for (held, damage) in heads {
        let head = held.head()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        upsert(&tx, &head, DirtyMark::Clear, &labels, None).map_err(|e| e.to_string())?;
        if let Some(damage) = damage {
            set_status_on(&tx, &head.session, SessionStatus::Damaged, Some(&damage)).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "DELETE").map_err(|e| e.to_string())?;
    Ok(())
}

/// What the reader of one session's log hands the index writer, in the order `project_session` makes it.
enum Projected {
    Started(CatalogHead),
    Frames(String, Vec<ProjectedFrame>),
    /// The log is read as far as it goes: the session's row, and its damage.
    Read(CatalogHead, Option<String>),
}

/// How many messages of one session wait for the index writer: a reader ahead of it holds this many read chunks.
const HANDOFF_DEPTH: usize = 2;

/// A log reader's way to the index writer of a rebuild.
struct Handoff(mpsc::SyncSender<Projected>);

impl Handoff {
    /// The writer left only by failing, and its error is the rebuild's.
    fn send(&self, message: Projected) -> Result<(), String> {
        self.0.send(message).map_err(|_| "the index writer stopped".to_owned())
    }
}

impl ProjectTo for Handoff {
    fn started(&mut self, head: &CatalogHead) -> Result<(), String> {
        self.send(Projected::Started(head.clone()))
    }

    fn frames(&mut self, session: &str, frames: Vec<ProjectedFrame>) -> Result<(), String> {
        self.send(Projected::Frames(session.to_owned(), frames))
    }
}

#[allow(clippy::disallowed_methods, reason = "blocking by contract: the caller is a maintenance lane job or the migration's own thread")]
fn project_sessions(
    conn: &mut Connection,
    data: &Path,
    sessions: &[String],
    progress: Option<&RebuildProgress>,
) -> Result<Vec<(HeldHead, Option<String>)>, String> {
    if let Some(progress) = progress {
        progress.begin(sessions.len());
    }
    let (senders, receivers): (Vec<_>, Vec<_>) = sessions.iter().map(|_| mpsc::sync_channel(HANDOFF_DEPTH)).unzip();
    let work = Mutex::new(sessions.iter().zip(senders));
    let cores = std::thread::available_parallelism().map_err(|e| format!("the number of cores could not be read: {e}"))?;
    let readers = usize::from(cores).min(sessions.len());
    std::thread::scope(|scope| {
        for _ in 0..readers {
            scope.spawn(|| {
                let blobs = crate::blobs::BlobStore::new(data);
                loop {
                    let Some((id, sender)) = work.lock().unwrap_or_else(std::sync::PoisonError::into_inner).next() else { return };
                    let dir = data.join("sessions").join(id);
                    let mut to = Handoff(sender);
                    let mut fold = None;
                    let Ok(read) = project_session(&mut to, &dir, &blobs, &mut fold, None) else { return };
                    let damage = read.err().map(|(error, at)| damage_text(&dir, at, &error));
                    let head = fold.as_ref().map_or_else(|| unreadable_head(id), CatalogHead::of);
                    if to.send(Projected::Read(head, damage)).is_err() {
                        return;
                    }
                    if let Some(progress) = progress {
                        progress.advance();
                    }
                }
            });
        }
        let mut heads = Vec::with_capacity(sessions.len());
        for (id, receiver) in sessions.iter().zip(receivers) {
            loop {
                let message = receiver.recv().map_err(|_| format!("{id}: its log's reader stopped"))?;
                match message {
                    Projected::Started(head) => ProjectTo::started(&mut *conn, &head),
                    Projected::Frames(session, frames) => ProjectTo::frames(&mut *conn, &session, frames),
                    Projected::Read(head, damage) => {
                        heads.push((HeldHead::of(&head), damage));
                        break;
                    }
                }
                .map_err(|e| format!("{id}: {e}"))?;
            }
        }
        Ok(heads)
    })
}

/// A session's row input, held from its read to the rebuild's last step: the header as JSON text. Decoded, the headers of
/// a large profile (tool catalogs of hundreds of KB in each) were most of the 6.2 GiB a rebuild of 2,829 sessions held.
struct HeldHead {
    session: String,
    log_id: String,
    base_session: Option<String>,
    header: Vec<u8>,
}

impl HeldHead {
    fn of(head: &CatalogHead) -> HeldHead {
        HeldHead {
            session: head.session.clone(),
            log_id: head.log_id.clone(),
            base_session: head.base_session.clone(),
            header: serde_json::to_vec(&head.header).expect("a header encodes"),
        }
    }

    /// The head as it was read: a JSON value decodes back to itself. The header was folded from records each read under
    /// the parser's nesting limit, and holds them deeper than any one of them (a stopped run's body under `owedStops`), so
    /// it is decoded with no limit of its own.
    fn head(self) -> Result<CatalogHead, String> {
        use serde::Deserialize as _;
        let mut de = serde_json::Deserializer::from_slice(&self.header);
        de.disable_recursion_limit();
        let header = serde_json::Map::<String, serde_json::Value>::deserialize(&mut de)
            .and_then(|header| de.end().map(|()| header))
            .map_err(|e| format!("{}: the held header: {e}", self.session))?;
        Ok(CatalogHead { session: self.session, log_id: self.log_id, base_session: self.base_session, header })
    }
}

#[cfg(test)]
mod held_head_tests {
    use super::*;

    /// A held header decodes to the header that was read: key order, numbers and escapes included.
    #[test]
    fn a_held_head_decodes_to_the_head_it_holds() {
        let header = serde_json::json!({"z": 1, "a": [0.1, 1e300, -0.0, 18446744073709551615u64, -9007199254740993i64], "\"q\"": "é\u{1F600}\n", "o": {"b": null, "a": true}});
        let head =
            CatalogHead { session: "sess_a".into(), log_id: "l".into(), base_session: Some("sess_b".into()), header: header.as_object().unwrap().clone() };
        let back = HeldHead::of(&head).head().unwrap();
        assert_eq!(back, head);
        assert_eq!(back.header.keys().collect::<Vec<_>>(), head.header.keys().collect::<Vec<_>>());
    }

    /// A stopped run's body read at the deepest nesting one record may hold is folded under `owedStops`, deeper than any
    /// record: the held header still decodes to it, so the rebuild writes the row it wrote from the folded header.
    #[test]
    fn a_header_deeper_than_any_one_record_is_held_and_decoded_whole() {
        let mut nested = serde_json::json!(1);
        for _ in 0..126 {
            nested = serde_json::Value::Array(vec![nested]);
        }
        let body_text = serde_json::to_string(&serde_json::json!({ "deep": nested })).unwrap();
        let body: serde_json::Value = serde_json::from_str(&body_text).expect("a record body within the parser's limit");
        let mut header = serde_json::Map::new();
        header.insert("title".into(), serde_json::json!("t"));
        crate::work_stops::apply(&mut header, "stop_1", crate::schema::record::WorkStopPhase::Stopped, Some(&body));
        let head = CatalogHead { session: "sess_a".into(), log_id: "l".into(), base_session: None, header };
        let held = HeldHead::of(&head);
        assert!(serde_json::from_slice::<serde_json::Value>(&held.header).is_err(), "the folded header is past one record's limit");
        assert_eq!(held.head().unwrap(), head);
    }
}

/// Why a log stopped before its end, and the damaged frame when the reader names it.
type LogFailure = (String, Option<crate::log::Damage>);

/// Where `project_session` writes: the index connection of a rebuild, or the writer thread
/// (the reconcile of an open index).
trait ProjectTo {
    /// The log's `session` frame was folded: a rebuild writes the row before its frames.
    fn started(&mut self, head: &CatalogHead) -> Result<(), String>;
    fn frames(&mut self, session: &str, frames: Vec<ProjectedFrame>) -> Result<(), String>;
}

impl ProjectTo for Connection {
    fn started(&mut self, head: &CatalogHead) -> Result<(), String> {
        let tx = self.transaction().map_err(|e| e.to_string())?;
        upsert(&tx, head, DirtyMark::Clear, &PlaceholderLabels::default(), None).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    fn frames(&mut self, session: &str, frames: Vec<ProjectedFrame>) -> Result<(), String> {
        apply_all(self, session, &frames).map_err(|e| e.to_string())
    }
}

/// A log reader's way into the open index, off the writer's thread: each piece of work it hands over is applied by the
/// writer a transaction at a time behind what the serving core writes, and the reader waits for the commit that completes
/// it (one read chunk of frames in memory at a time). The log is decoded here, never on the writer.
#[derive(Clone, Copy)]
struct ToWriter<'a> {
    sender: &'a mpsc::Sender<Command>,
    /// The session the work is of: whose debt it settles, and whose turn it takes.
    session: &'a str,
}

impl ToWriter<'_> {
    fn send(&self, work: RepairWork) -> Result<(), String> {
        let (ack, done) = mpsc::channel();
        let stopped = || "the index writer stopped".to_owned();
        self.sender.send(Command::Repair { work, ack }).map_err(|_| stopped())?;
        done.recv().map_err(|_| stopped())?.map_err(|e| e.to_string())
    }

    /// [`Self::replay`] of `frames` with the row `start` holds (taken), or nothing when there is neither.
    fn replay_from(&self, folded: &str, start: &mut Option<CatalogHead>, frames: Vec<ProjectedFrame>) -> Result<(), String> {
        if frames.is_empty() && start.is_none() {
            return Ok(());
        }
        self.replay(folded, start.take(), frames)
    }

    /// `frames`, folded as `folded`; with `start`, the row written dirty before them.
    fn replay(&self, folded: &str, start: Option<CatalogHead>, frames: Vec<ProjectedFrame>) -> Result<(), String> {
        self.send(RepairWork::Replay(Box::new(Replay {
            session: self.session.to_owned(),
            frames_session: folded.to_owned(),
            start,
            frames,
            next: 0,
            part: 0,
            finish: None,
            split: true,
            partial: false,
        })))
    }
}

impl ProjectTo for ToWriter<'_> {
    /// The row is there (it is marked dirty); it is written once the log is folded.
    fn started(&mut self, _head: &CatalogHead) -> Result<(), String> {
        Ok(())
    }

    fn frames(&mut self, session: &str, frames: Vec<ProjectedFrame>) -> Result<(), String> {
        if frames.is_empty() {
            return Ok(());
        }
        self.replay(session, None, frames)
    }
}

/// The way into the open index of a session replayed from its first frame: the head at its `session` frame goes with the
/// first frames, as the row written dirty before them.
struct Streaming<'a> {
    to: ToWriter<'a>,
    start: Option<CatalogHead>,
}

impl ProjectTo for Streaming<'_> {
    fn started(&mut self, head: &CatalogHead) -> Result<(), String> {
        self.start = Some(head.clone());
        Ok(())
    }

    fn frames(&mut self, session: &str, frames: Vec<ProjectedFrame>) -> Result<(), String> {
        self.to.replay_from(session, &mut self.start, frames)
    }
}

/// The way into the open index of a session it holds no row of ([`SqliteStore::adopt`]): the row is written first, marked
/// dirty, as a rebuild writes it before the frames; then each message is applied by the writer thread while the caller waits.
struct Adopting<'a> {
    sender: &'a mpsc::Sender<Command>,
    /// The session is listed by a pending row ([`PENDING_LOG_ID`]), which holds no frame yet.
    pending: bool,
}

impl Adopting<'_> {
    fn ask(&self, make: impl FnOnce(Ack) -> Command) -> Result<(), String> {
        let stopped = || "the index writer stopped".to_owned();
        let (ack, done) = oneshot::channel();
        self.sender.send(make(ack)).map_err(|_| stopped())?;
        done.blocking_recv().map_err(|_| stopped())?.map_err(|e| e.to_string())
    }

    fn row(&self, head: &CatalogHead, dirty: DirtyMark) -> Result<(), String> {
        self.ask(|ack| Command::Upsert { head: Arc::new(head.clone()), dirty, ack: Some(ack) })
    }

    /// The pending row becomes the row of the log that is there now: its identity, marked dirty until the folded row is
    /// written. What it lists stays as it was meanwhile.
    fn arrived(&self, session: &str, log_id: &str, base_session: Option<&str>) -> Result<(), String> {
        let (session, log_id, base_session) = (session.to_owned(), log_id.to_owned(), base_session.map(str::to_owned));
        self.ask(|ack| Command::Arrived { session, log_id, base_session, ack })
    }
}

impl ProjectTo for Adopting<'_> {
    fn started(&mut self, head: &CatalogHead) -> Result<(), String> {
        if self.pending {
            return self.arrived(&head.session, &head.log_id, head.base_session.as_deref());
        }
        self.row(head, DirtyMark::Set)
    }

    fn frames(&mut self, session: &str, frames: Vec<ProjectedFrame>) -> Result<(), String> {
        if frames.is_empty() {
            return Ok(());
        }
        ToWriter { sender: self.sender, session }.replay(session, None, frames)
    }
}

/// The way into the open index of a session a rebuild owes: what its log reads is held to go as one whole session
/// ([`Replay::finish`]); past [`APPEND_ROWS`] frames it spills, and goes on a read chunk at a time ([`Streaming`]).
struct Collecting<'a> {
    to: ToWriter<'a>,
    start: Option<CatalogHead>,
    session: String,
    frames: Vec<ProjectedFrame>,
    spilled: bool,
}

impl Collecting<'_> {
    /// What is held goes in a message, and nothing is held from here on.
    fn spill(&mut self) -> Result<(), String> {
        if std::mem::replace(&mut self.spilled, true) {
            return Ok(());
        }
        let frames = std::mem::take(&mut self.frames);
        self.to.replay_from(&self.session, &mut self.start, frames)
    }
}

impl ProjectTo for Collecting<'_> {
    fn started(&mut self, head: &CatalogHead) -> Result<(), String> {
        self.start = Some(head.clone());
        Ok(())
    }

    fn frames(&mut self, session: &str, frames: Vec<ProjectedFrame>) -> Result<(), String> {
        if self.spilled {
            return self.to.replay_from(session, &mut self.start, frames);
        }
        session.clone_into(&mut self.session);
        self.frames.extend(frames);
        if self.frames.len() > APPEND_ROWS {
            return self.spill();
        }
        Ok(())
    }
}

/// The `log_id` of the row of a session the migration has still to convert: it has no log yet. The row is what the earlier
/// version listed for it, so the session is in the list from the first start; taking the session in replaces it.
pub const PENDING_LOG_ID: &str = "migration-pending";

impl SqliteStore {
    /// Lists the sessions the migration has still to convert, each by the row the earlier version kept of it: a head's
    /// `header` and its stats are that row's fields, and its `log_id` is [`PENDING_LOG_ID`]. A session the index holds a
    /// row of is left as it is. All of them are written in one transaction.
    pub async fn list_pending(&self, sessions: Vec<(CatalogHead, crate::summary::MessageStats)>) -> Result<(), DbError> {
        self.ask(|ack| Command::Pending { sessions, ack }).await
    }

    /// The sessions still listed by a pending row that have no log under `<data>/sessions`: listed, and not there. What
    /// its caller withdraws: the complete set, read once every session owed its rows is ready, or an error and nothing.
    #[allow(clippy::disallowed_methods, reason = "runs on the read lane job (lane proof argument)")]
    pub async fn pending_sessions(&self, data: &Path) -> Result<Vec<String>, DbError> {
        let sessions = data.join("sessions");
        Ok(self
            .shared
            .gate
            .read_exact_in_lane(Need::All, move |_, c| {
                let mut stmt = c.prepare_cached("SELECT id FROM sessions WHERE log_id = ?1 AND deleted = 0")?;
                let listed: Vec<String> = stmt.query_map([PENDING_LOG_ID], |r| r.get(0))?.collect::<Result<_, _>>()?;
                Ok(listed.into_iter().filter(|id| !sessions.join(id).join(crate::log::log_name(0)).is_file()).collect())
            })
            .await?)
    }

    /// Brings a session whose folder another writer published under `<data>/sessions` while the index is open (the
    /// migration, converting behind a serving core) into the index: its row, then every frame of its log, then the row again
    /// from the folded log, written clean. The row goes through the writer's own upsert, so the row sink is told of it as of
    /// any created session. A session the index already holds a row of is left as it is, unless the row is a pending one
    /// ([`PENDING_LOG_ID`]): that row stays as listed while the frames go in from the cursor it holds, and the folded row
    /// replaces it. A process that ends in between leaves the row to be taken in again, from its cursor.
    ///
    /// Blocks the calling thread on the log's reads and the writer's answers: it must be no runtime's thread.
    #[allow(clippy::disallowed_methods, reason = "blocking by contract: the caller is the migration's own thread")]
    pub fn adopt(&self, data: &Path, session: &str) -> Result<(), DbError> {
        let held: Option<String> =
            self.with_of(&[session], |c| Ok(c.prepare_cached("SELECT log_id FROM sessions WHERE id = ?1")?.query_row([session], |r| r.get(0)).optional()?))?;
        // A pending row holds no frame: the row takes the log's identity at its first frame, dirty from there on, so a process
        // that ends after it leaves a session the boot reconcile finishes (and this, on the next run, leaves alone).
        let pending = match held.as_deref() {
            None => false,
            Some(PENDING_LOG_ID) => true,
            Some(_) => return Ok(()),
        };
        let mut to = Adopting { sender: self.shared.gate.feed(&[session])?, pending };
        let dir = data.join("sessions").join(session);
        let mut fold = None;
        let damage = project_session(&mut to, &dir, &crate::blobs::BlobStore::new(data), &mut fold, None)
            .map_err(DbError::Write)?
            .err()
            .map(|(error, at)| damage_text(&dir, at, &error));
        let head = fold.as_ref().map_or_else(|| unreadable_head(session), CatalogHead::of);
        if pending && fold.is_none() {
            // A log with no readable first frame: the row is that of an unreadable session, which is never listed.
            to.arrived(session, &head.log_id, None).map_err(DbError::Write)?;
        }
        to.row(&head, DirtyMark::Clear).map_err(DbError::Write)?;
        if let Some(damage) = damage {
            let session = session.to_owned();
            to.ask(|ack| Command::Status { session, status: SessionStatus::Damaged, damage: Some(damage), ack }).map_err(DbError::Write)?;
        }
        Ok(())
    }
}

/// The rows of a rewritten session rebuilt from its log ([`SqliteStore::reproject`]): its rows purged, its hole recorded
/// with the first of them, its log read here and replayed by the writer, then its row, with which the hole goes.
#[allow(clippy::disallowed_methods, reason = "blocking by contract: runs inside a read lane job")]
fn replay_rewritten(sender: &mpsc::Sender<Command>, rewrite: &Rewritten) -> Result<(), String> {
    let Rewritten { data, session, dirty } = rewrite;
    let to = ToWriter { sender, session };
    to.send(RepairWork::Purge { session: session.clone(), started: false })?;
    #[cfg(test)]
    reconcile_seam::wait_in_rebuild(data);
    let dir = data.join("sessions").join(session);
    let mut fold = None;
    let damage = project_session(&mut Streaming { to, start: None }, &dir, &crate::blobs::BlobStore::new(data), &mut fold, None)?
        .err()
        .map(|(error, at)| damage_text(&dir, at, &error));
    let head = fold.as_ref().map_or_else(|| unreadable_head(session), CatalogHead::of);
    to.send(RepairWork::Finish(Box::new(Finish { session: session.clone(), head, damage, dirty: *dirty, recovery: false, replaced: true, viewing: false })))
}

/// The repairs a start owes (RL §9.2 rule 5), on their own thread: one session at a time, in the order the gate gives
/// them, each settled as it ends so the accesses that wait for it go on while the rest are repaired.
fn repair_owed(repairer: &gate::Repairer, data: &Path) {
    let blobs = crate::blobs::BlobStore::new(data);
    while let Some((session, forced)) = repairer.next() {
        #[cfg(any(test, feature = "test-support"))]
        repair_hold::wait_if_held(data, &session);
        if repair_and_settle(repairer, data, &blobs, &session, forced).is_none() {
            // As a process ending there: nothing more is repaired, and what is pending stays so.
            repairer.end();
            return;
        }
    }
}

/// [`repair_session`], then its outcome settled. `None`: the test seam ended the process mid-repair; dropping the repairer
/// fails every access to what is pending.
fn repair_and_settle(repairer: &gate::Repairer, data: &Path, blobs: &crate::blobs::BlobStore, session: &str, forced: bool) -> Option<()> {
    let outcome = match repair_session(repairer, data, blobs, session, forced) {
        Ok(Some(outcome)) => outcome,
        Ok(None) => return None,
        Err(why) => gate::Repaired::Failed(format!("{session}: {why}")),
    };
    #[cfg(test)]
    reconcile_seam::wait_before_settle(data, session);
    repairer.settle(session, outcome);
    Some(())
}

/// The repair of one session: its log projected from the index's cursor on, then its row, written clean; rebuilt from its
/// first frame when its rows hold frames past the cursor. A session of the withheld set is not projected (unless
/// `forced`: it is being released, its rewrite done). `Ok(None)`: the test seam ended it, as a process ending there.
#[allow(clippy::disallowed_methods, reason = "blocking by contract: runs on the repairs' own thread")]
fn repair_session(
    repairer: &gate::Repairer,
    data: &Path,
    blobs: &crate::blobs::BlobStore,
    session: &str,
    forced: bool,
) -> Result<Option<gate::Repaired>, String> {
    let (pool, sender) = (&repairer.pool, &repairer.sender);
    if !forced && pool.with(|c| Ok(withheld::is_withheld_in(c, session)?)).map_err(|e| e.to_string())? {
        return Ok(Some(gate::Repaired::Left));
    }
    let dir = data.join("sessions").join(session);
    let meta_held = |key: String| pool.with(|c| Ok(c.prepare_cached("SELECT 1 FROM meta WHERE key = ?1")?.exists([key])?)).map_err(|e| e.to_string());
    let holed = meta_held(hole_key(session))?;
    let owed_rebuild = !holed && meta_held(rebuild_key(session))?;
    if !holed && !owed_rebuild && !dir.is_dir() {
        return Ok(Some(gate::Repaired::Done));
    }
    #[cfg(test)]
    if reconcile_seam::fails_here(data) || reconcile_seam::fails_session(data, session) {
        return Err("the test seam failed the index write".to_owned());
    }
    let to = ToWriter { sender, session };
    if !dir.is_dir() {
        // A session owed its rows whose folder went meanwhile: nothing is left to rebuild them from.
        to.send(RepairWork::Forget { session: session.to_owned() })?;
        return Ok(Some(gate::Repaired::Done));
    }
    let mut fold = None;
    let mut collecting = None;
    let read = if holed {
        // Its rows hold frames past its cursor, or a rebuild of them was cut off (its row is then gone, or dirty with
        // part of its frames in): they are not continued from the cursor. They go, the hole kept, and the log is replayed
        // from its first frame, read here and applied by the writer a transaction at a time.
        to.send(RepairWork::Purge { session: session.to_owned(), started: false })?;
        #[cfg(test)]
        reconcile_seam::wait_in_rebuild(data);
        project_session(&mut Streaming { to, start: None }, &dir, blobs, &mut fold, None)?
    } else if owed_rebuild {
        // No row yet: the log is read whole for one transaction shared with the other repairs', or past its size the row
        // is written dirty at the log's first frame and the frames follow.
        let collected = collecting.insert(Collecting { to, start: None, session: session.to_owned(), frames: Vec::new(), spilled: false });
        project_session(collected, &dir, blobs, &mut fold, None)?
    } else {
        let from = pool.with(|c| projected_on(c, session)).map_err(|e| e.to_string())?;
        let mut to = to;
        project_session(&mut to, &dir, blobs, &mut fold, from)?
    };
    let damage = read.err().map(|(error, at)| damage_text(&dir, at, &error));
    #[cfg(test)]
    if reconcile_seam::ends_here(data) {
        return Ok(None);
    }
    let head = fold.as_ref().map_or_else(|| unreadable_head(session), CatalogHead::of);
    let finish = |head, damage| Finish { session: session.to_owned(), head, damage, dirty: DirtyMark::Clear, recovery: true, replaced: holed, viewing: false };
    if let Some(mut collected) = collecting {
        // A fork's row waits for its base's view: it goes the way below, which computes the view once the base is in.
        if !collected.spilled && head.base_session.is_none() {
            to.send(RepairWork::Replay(Box::new(Replay {
                session: session.to_owned(),
                frames_session: std::mem::take(&mut collected.session),
                start: collected.start.take(),
                frames: std::mem::take(&mut collected.frames),
                next: 0,
                part: 0,
                finish: Some(finish(head, damage)),
                split: false,
                partial: false,
            })))?;
            return Ok(Some(gate::Repaired::Done));
        }
        collected.spill()?;
    }
    // A fork is not ready before the base it reads: a base owed a repair too (a rebuild owes every session) is repaired
    // first, by this thread when no other holds it. A base that failed fails the fork, and one held for its rewrite holds
    // the fork until it is released.
    if let Some(base) = head.base_session.as_deref() {
        loop {
            match repairer.take_or_wait(base, session) {
                gate::Base::Take(forced) => {
                    if repair_and_settle(repairer, data, blobs, base, forced).is_none() {
                        return Ok(None);
                    }
                }
                gate::Base::Ready => break,
                gate::Base::Held => return Ok(Some(gate::Repaired::LeftFor(base.to_owned()))),
                gate::Base::Failed(why) => return Err(format!("its base {base} was not recovered ({why})")),
                gate::Base::Stopped => return Err("the index writer stopped".to_owned()),
            }
        }
    }
    to.send(RepairWork::Finish(Box::new(finish(head, damage))))?;
    Ok(Some(gate::Repaired::Done))
}

fn fold_owned(record: &crate::schema::record::Record) -> bool {
    use crate::schema::record::Record;
    matches!(record, Record::Session(_) | Record::Checkpoint(_) | Record::Meta(_))
}

/// What a record projects to: a record whose body is lost keeps its references and op and no rows of its own; an unreadable
/// body that is no loss (an I/O error that may pass) fails the read.
fn project_record(
    record: &crate::schema::record::Record,
    ordinal: u64,
    resolve: &mut crate::fold::ResolveBody<'_>,
    gone: &std::cell::RefCell<Vec<crate::schema::bounded::Digest>>,
    losses: &mut crate::fold::Losses,
) -> Result<(FrameKind, Option<crate::projection::ProjectedOp>, Option<crate::projection::Receipt>), String> {
    let (kind, op) = match crate::projection::project(record, resolve) {
        Ok(projected) => projected,
        Err(e) => {
            let digests = crate::fold::take_lost(gone).ok_or(e)?;
            if !fold_owned(record) {
                losses.row(ordinal, digests);
            }
            (FrameKind::Other, crate::projection::record_op(record))
        }
    };
    let receipt = match crate::projection::receipt(record, resolve) {
        Ok(receipt) => receipt,
        Err(e) => {
            let digests = crate::fold::take_lost(gone).ok_or(e)?;
            if !fold_owned(record) {
                losses.row(ordinal, digests);
            }
            None
        }
    };
    for blob in crate::projection::unread_bodies(record) {
        if let Err(e) = resolve(blob) {
            losses.row(ordinal, crate::fold::take_lost(gone).ok_or(e)?);
        }
    }
    Ok((kind, op, receipt))
}

/// Projects the log in `dir` forward into `to`, folding into `fold`. The outer error is
/// an index write failure; the inner one is the log's own failure, after which the frames
/// before it stay projected. `from`: the index already holds every frame before this one
/// (the reconcile), so those are folded only.
fn project_session(
    to: &mut impl ProjectTo,
    dir: &Path,
    blobs: &crate::blobs::BlobStore,
    fold: &mut Option<crate::fold::Fold>,
    from: Option<FramePos>,
) -> Result<Result<(), LogFailure>, String> {
    use crate::log::ForwardEnd;
    let log = |e: String| (e, None);
    // The end of the read: the log's own failure with the losses.
    let finish = |losses: &crate::fold::Losses, failure: Option<LogFailure>| -> Result<Result<(), LogFailure>, String> {
        Ok(match failure {
            None if losses.is_empty() => Ok(()),
            None => Err((losses.describe(), None)),
            Some((error, at)) if losses.is_empty() => Err((error, at)),
            Some((error, at)) => Err((format!("{error}; {}", losses.describe()), at)),
        })
    };
    let first = match crate::log::first_ordinal_unlaned(dir) {
        Ok(first) => first,
        Err(e) => return finish(&crate::fold::Losses::default(), Some(log(e.to_string()))),
    };
    let start = FramePos { ordinal: first, file_no: 0, offset: 0 };
    let mut pos = start;
    let mut from = from;
    // A body whose blob is missing or corrupt stops nothing (FORMAT.md §4.5): its record is folded and projected as far
    // as it can be, every later frame is projected with its references, and the losses become the session's damage.
    let gone = std::cell::RefCell::new(Vec::new());
    let mut resolve = crate::fold::noting(blobs, &gone);
    let mut losses = crate::fold::Losses::default();
    // The fold was restored from an anchor: it holds no row from before it, so a record that reaches behind the anchor (a
    // rewind across it) cannot be folded from there. Such a record is no damage: the log is folded again from its first frame.
    let mut anchored = false;
    if let Some(from) = from
        && fold.is_none()
        && let Some((anchor, restored, next)) = crate::log::anchor_fold_before_unlaned(dir, from, &mut resolve)
        && anchor.ordinal < from.ordinal
    {
        *fold = Some(restored);
        pos = next;
        anchored = true;
    }
    // An anchor that did not read is no loss: the fold starts at the `session` frame instead.
    crate::fold::take_lost(&gone);
    loop {
        let read = match crate::log::read_forward_unlaned(dir, pos, APPEND_BYTES as u64) {
            Ok(read) => read,
            Err(e) => return finish(&losses, Some(log(e.to_string()))),
        };
        let mut frames = Vec::with_capacity(read.frames.len());
        let mut failure = None;
        let mut refold = None;
        for (record, at, frame_len) in &read.frames {
            let folded = crate::fold::fold_salvaging(fold, record, *at, &mut resolve, &gone, &mut losses);
            let started = match folded {
                Ok(started) => started,
                Err(_) if std::mem::take(&mut anchored) => {
                    refold = Some(*at);
                    break;
                }
                Err(e) => {
                    failure = Some(log(e));
                    break;
                }
            };
            let f = fold.as_ref().expect("folded");
            if started && from.is_none() {
                to.started(&CatalogHead::of(f))?;
            }
            if from.is_some_and(|from| at.ordinal < from.ordinal) {
                continue;
            }
            let (kind, op, receipt) = match project_record(record, at.ordinal, &mut resolve, &gone, &mut losses) {
                Ok(projected) => projected,
                Err(e) => {
                    failure = Some(log(e));
                    break;
                }
            };
            frames.push(ProjectedFrame {
                pos: *at,
                frame_len: *frame_len,
                kind,
                op,
                receipt,
                history_rev: f.history_rev,
                rows: f.rows,
                visible_rows: f.visible_rows,
            });
        }
        let folded_session = fold.as_ref().map(|f| f.session.clone()).unwrap_or_default();
        to.frames(&folded_session, frames)?;
        if let Some(at) = refold {
            // From the first frame, what the index holds is folded only: every frame before the cursor the read started
            // with, and those this pass projected up to `at`. So the boundary is the later of the two: a failure in the
            // part before the cursor (folded only, between the anchor and it) projects nothing a second time.
            crate::fold::take_lost(&gone);
            *fold = None;
            from = from.filter(|from| from.ordinal >= at.ordinal).or(Some(at));
            pos = start;
            continue;
        }
        if let Some(failure) = failure {
            return finish(&losses, Some(failure));
        }
        match read.next {
            ForwardEnd::More(next) => pos = next,
            ForwardEnd::Done { .. } if fold.is_some() => return finish(&losses, None),
            ForwardEnd::Done { .. } => return finish(&losses, Some(log("the log holds no frame".into()))),
            ForwardEnd::Damaged(d) => return finish(&losses, Some(("a frame fails its check".into(), Some(d)))),
        }
    }
}

/// `sessions.damage` (FORMAT.md §3.4): the log file, the error, and the damaged frame
/// when the reader names it.
fn damage_text(dir: &Path, at: Option<crate::log::Damage>, error: &str) -> String {
    let file_no = at.as_ref().map_or(0, |d| d.file_no);
    let mut damage = serde_json::json!({
        "path": dir.join(crate::log::log_name(file_no)).to_string_lossy(),
        "error": error,
    });
    if let Some(d) = at {
        damage["file_no"] = d.file_no.into();
        damage["offset"] = d.offset.into();
        damage["ordinal"] = d.ordinal.into();
    }
    damage.to_string()
}

/// The row of a session whose log has no readable `session` frame: no header, no
/// `log_id`, so it is never listed, searched or summarized; only its damage is kept.
fn unreadable_head(id: &str) -> CatalogHead {
    let mut header = serde_json::Map::new();
    header.insert("id".into(), id.into());
    CatalogHead { session: id.to_owned(), log_id: String::new(), base_session: None, header }
}

/// `Date.now()` for a header without `updatedAt`.
fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

/// `frames` into a connection no serving core writes through (the migration's projector, a store before it serves), each
/// transaction one step of [`apply_frames`]. The serving writer applies one such step a dispatch ([`Writer::replay_part`]),
/// and looks at its queue between two.
fn apply_all(conn: &mut Connection, session: &str, frames: &[ProjectedFrame]) -> rusqlite::Result<()> {
    let (mut next, mut part) = (0, 0);
    loop {
        let tx = conn.transaction()?;
        let done = apply_frames(&tx, session, frames, &mut next, &mut part, &mut Budget::new(APPEND_ROWS))?;
        tx.commit()?;
        if done {
            return Ok(());
        }
    }
}

/// One compaction divider of the display history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Divider {
    pub session: String,
    pub cid: String,
    /// The `compacted` frame.
    pub pos: FramePos,
    pub frame_len: u64,
    /// The divider precedes the first displayed row of `lineage[level]` with an ordinal at
    /// or above `boundary`.
    pub level: usize,
    pub boundary: u64,
    /// The compaction's `Date.now()` in milliseconds, when the record carries it.
    pub at: Option<i64>,
    /// The model-switch boundaries anchored on a replacement entry of this compaction (the
    /// 1.4.5 summary message's `meta.modelSwitches`, FORMAT.md §5.3): shown after the
    /// divider, by entry position, then oldest lineage level first, then record order.
    pub model_switches: Vec<ModelSwitchEntry>,
}

/// One occurrence of a transcript page: a history row, or the boundary of a compaction that lists a divider, at the
/// compaction's own record. Both have an ordinal of their log, so the occurrences of a lineage are in one order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnitRow {
    Item(HistoryRow),
    Boundary(Divider),
}

impl UnitRow {
    pub fn ordinal(&self) -> u64 {
        match self {
            UnitRow::Item(row) => row.ordinal,
            UnitRow::Boundary(divider) => divider.pos.ordinal,
        }
    }
}

fn clamp_i64(v: u64) -> i64 {
    v.min(i64::MAX as u64) as i64
}

/// The model-switch boundaries anchored on a replacement entry of the compaction at `ordinal` of `lineage[home]`: the
/// compaction's own log and each later level's up to its fork point, ordered by entry position, level, record.
fn entry_switches(c: &Connection, lineage: &[LineageLevel], home: usize, ordinal: i64) -> Result<Vec<ModelSwitchEntry>, DbError> {
    let mut found = Vec::new();
    for (rank, holder) in lineage[..=home].iter().rev().enumerate() {
        let end = holder.end.map_or(i64::MAX, clamp_i64);
        let mut stmt = c.prepare_cached(ENTRY_SWITCHES_SQL)?;
        let rows = stmt.query_map(params![holder.session, ordinal, lineage[home].session, end], |s| {
            Ok(((s.get::<_, i64>(0)?, rank, s.get::<_, i64>(1)?), ModelSwitchEntry { provider: s.get(2)?, model_id: s.get(3)?, at: s.get(4)? }))
        })?;
        for row in rows {
            found.push(row?);
        }
    }
    found.sort_by_key(|(key, _)| *key);
    Ok(found.into_iter().map(|(_, entry)| entry).collect())
}

fn dividers_on(c: &Connection, lineage: &[LineageLevel], cut: Option<u64>, level: usize, from: u64, to: u64) -> Result<Vec<Divider>, DbError> {
    // A divider sits at its compaction's own record (`archive_index::divider_place`): those of `level` in `[from, to)`
    // are that level's compactions there, which the query bounds, so a window asks for no compaction outside it.
    let Some(home) = lineage.get(level) else { return Ok(Vec::new()) };
    let asof = home.end.map_or(i64::MAX, clamp_i64);
    let to = clamp_i64(to).min(crate::archive_index::level_bound(lineage, cut, level));
    boundaries_on(c, lineage, level, (clamp_i64(from), to), asof, -1, false)
}

/// The boundaries of `lineage[level]`'s compactions that list a divider, with ordinals in `span` (`[from, to)`), live for
/// the reader at `asof`: at most `limit` of them (`-1`: all), oldest first or `newest_first`.
fn boundaries_on(
    c: &Connection,
    lineage: &[LineageLevel],
    level: usize,
    span: (i64, i64),
    asof: i64,
    limit: i64,
    newest_first: bool,
) -> Result<Vec<Divider>, DbError> {
    let home = &lineage[level];
    let mut stmt = c.prepare_cached(if newest_first { BOUNDARIES_NEWEST_SQL } else { BOUNDARIES_SQL })?;
    let found = stmt
        .query_map(params![home.session, asof, span.0, span.1, limit], |r| {
            Ok((r.get::<_, i64>(0)?, (r.get::<_, u32>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?), r.get::<_, String>(4)?, r.get::<_, Option<i64>>(5)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = Vec::new();
    for (ordinal, (file_no, offset, len), cid, at) in found {
        let place = crate::archive_index::divider_place(level, ordinal as u64);
        out.push(Divider {
            session: home.session.clone(),
            cid,
            pos: FramePos { ordinal: ordinal as u64, file_no, offset: offset as u64 },
            frame_len: len as u64,
            level: place.0,
            boundary: place.1,
            at,
            model_switches: entry_switches(c, lineage, level, ordinal)?,
        });
    }
    Ok(out)
}

macro_rules! boundaries_sql {
    ($order:literal) => {
        concat!(
            "SELECT ordinal, file_no, frame_offset, frame_len, cid, at
     FROM compactions
     WHERE session = ?1 AND ordinal >= ?3 AND ordinal < ?4 AND silent = 0 AND (superseded_rev IS NULL OR superseded_rev >= ?2)
     ORDER BY ordinal ",
            $order,
            " LIMIT ?5"
        )
    };
}

/// The compactions of session `?1` in `[?3, ?4)` that list a divider, live for the reader at `?2`, oldest first, at most
/// `?5` (`-1`: all).
pub(crate) const BOUNDARIES_SQL: &str = boundaries_sql!("ASC");

/// [`BOUNDARIES_SQL`], newest first.
pub(crate) const BOUNDARIES_NEWEST_SQL: &str = boundaries_sql!("DESC");

/// The newest compaction `?2` of session `?1` below `?3` that lists a divider, live for the reader at `?4`.
pub(crate) const BOUNDARY_NAMED_SQL: &str = "SELECT ordinal FROM compactions INDEXED BY compactions_cid
     WHERE session = ?1 AND cid = ?2 AND ordinal < ?3 AND silent = 0 AND (superseded_rev IS NULL OR superseded_rev >= ?4)
     ORDER BY ordinal DESC LIMIT 1";

/// For each `(level, turn)`: whether a compaction took a model message of the turn out of the context, and whether one of
/// its messages is left, over every message of the turn the reader of `lineage` sees. A page shows a turn's end as the
/// whole history does, whichever of the turn's messages it holds itself.
///
/// The turn's messages are found by the turn (`history_turn`) in each level the reader sees, as the whole history keys
/// them: the lookup costs the turn's own messages, wherever in its log they lie and whatever ran before them. It ends
/// at the first message left: the answer is decided then.
fn turn_messages_on(c: &Connection, lineage: &[LineageLevel], cut: Option<u64>, turns: &[String]) -> Result<Vec<(bool, bool)>, DbError> {
    let mut compactions = crate::archive_index::Compactions::new(c, lineage, cut);
    let mut out = Vec::with_capacity(turns.len());
    for turn in turns {
        let (mut gone, mut left) = (false, false);
        for (level, home) in lineage.iter().enumerate() {
            let (before, floor) = level_bounds(lineage, cut, level, u64::MAX);
            let mut stmt = c.prepare_cached(TURN_MESSAGES_SQL)?;
            let mut rows = stmt.query(params![home.session, clamp_i64(before), floor, turn])?;
            while let Some(r) = rows.next()? {
                let (ordinal, iid): (i64, String) = (r.get(0)?, r.get(1)?);
                let facets = r.get::<_, Option<String>>(3)?.and_then(|f| serde_json::from_str::<crate::message_facets::Facets>(&f).ok());
                let archived = match facets {
                    Some(facets) if r.get::<_, i64>(2)? != 1 => compactions.verdict(level, ordinal as u64, &iid, &facets)?.archived,
                    _ => false,
                };
                gone |= archived;
                left |= !archived;
                if left {
                    break;
                }
            }
            if left {
                break;
            }
        }
        out.push((gone, left));
    }
    Ok(out)
}

/// The lineage level whose visible range holds the history row at `ordinal`, and that row's turn.
fn row_home(c: &Connection, lineage: &[LineageLevel], cut: Option<u64>, ordinal: u64) -> Result<Option<(usize, Option<String>)>, DbError> {
    for level in (0..lineage.len()).rev() {
        let (before, floor) = level_bounds(lineage, cut, level, u64::MAX);
        if ordinal >= before {
            continue;
        }
        let turn = c
            .prepare_cached("SELECT turn FROM history WHERE session = ?1 AND ordinal = ?2 AND (superseded_rev IS NULL OR superseded_rev >= ?3)")?
            .query_row(params![lineage[level].session, clamp_i64(ordinal), floor], |r| r.get::<_, Option<String>>(0))
            .optional()?;
        if let Some(turn) = turn {
            return Ok(Some((level, turn)));
        }
    }
    Ok(None)
}

fn call_results_on(c: &Connection, lineage: &[LineageLevel], cut: Option<u64>, calls: &[(u64, String)]) -> Result<Vec<HistoryRow>, DbError> {
    // One walk per turn that holds asked calls, from the oldest record that shows one.
    let mut walks: Vec<(usize, Option<String>, u64, Vec<&str>)> = Vec::new();
    for (ordinal, call) in calls {
        let Some((level, turn)) = row_home(c, lineage, cut, *ordinal)? else { continue };
        match walks.iter_mut().find(|walk| walk.0 == level && walk.1 == turn) {
            Some(walk) => {
                walk.2 = walk.2.min(*ordinal);
                walk.3.push(call.as_str());
            }
            None => walks.push((level, turn, *ordinal, vec![call.as_str()])),
        }
    }
    let mut compactions = crate::archive_index::Compactions::new(c, lineage, cut);
    let mut found: Vec<(usize, HistoryRow)> = Vec::new();
    for (home, turn, after, mut left) in walks {
        // The call's own log first, then each later level's, which continues it.
        let mut home_done = false;
        for level in (0..=home).rev() {
            if left.is_empty() || home_done {
                break;
            }
            let (before, floor) = level_bounds(lineage, cut, level, u64::MAX);
            let from = if level == home { after + 1 } else { 0 };
            // Rows of no turn answer one another only within their run: it ends at the first row of a turn.
            let closed = match turn {
                Some(_) => None,
                None => c
                    .prepare_cached(TURNLESS_RUN_END_SQL)?
                    .query_row(params![lineage[level].session, clamp_i64(from), clamp_i64(before), floor], |r| r.get::<_, i64>(0))
                    .optional()?,
            };
            let before = closed.map_or(before, |end| end as u64);
            // A turn-less run that ended in this level does not continue in a later one.
            if closed.is_some() {
                home_done = true;
            }
            let mut stmt = c.prepare_cached(CALL_RESULTS_SQL)?;
            let mut rows = stmt.query(params![lineage[level].session, clamp_i64(before), floor, turn, clamp_i64(from), amend_bound(lineage, cut, level)])?;
            while let Some(r) = rows.next()? {
                let Some(facets) = r.get::<_, Option<String>>(12)?.and_then(|f| serde_json::from_str::<crate::message_facets::Facets>(&f).ok()) else {
                    continue;
                };
                if facets.role != "tool" {
                    continue;
                }
                let Some(at) = left.iter().position(|call| facets.calls.iter().any(|answered| answered.as_str() == *call)) else { continue };
                left.swap_remove(at);
                let (frame, _) = row_frame(r)?;
                found.push((level, history_row(c, lineage, level, floor, &mut compactions, r, frame)?));
                if left.is_empty() {
                    break;
                }
            }
        }
    }
    // Oldest first: the deepest level, then each level's rows in their order.
    found.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.ordinal.cmp(&b.1.ordinal)));
    found.dedup_by(|a, b| a.0 == b.0 && a.1.ordinal == b.1.ordinal);
    Ok(found.into_iter().map(|(_, row)| row).collect())
}

/// [`PAGE_AFTER_SQL`] over the model rows of turn `?4` (`NULL`: the rows of no turn) from `?5` on. The index is named:
/// the walk costs the turn's own rows.
pub(crate) const CALL_RESULTS_SQL: &str = "SELECT h.ordinal, h.iid, h.turn, h.form, h.model, h.file_no, h.frame_offset, h.frame_len,
       a.ordinal, a.file_no, a.frame_offset, a.frame_len,
       h.facets, h.end_form
     FROM history h INDEXED BY history_turn LEFT JOIN amends a ON a.session = h.session AND a.ordinal = (SELECT max(x.ordinal) FROM amends x WHERE x.session = h.session
       AND x.target_ordinal = h.ordinal AND x.ordinal < ?6 AND (x.superseded_rev IS NULL OR x.superseded_rev >= ?6))
     WHERE h.session = ?1 AND h.turn IS ?4 AND h.ordinal < ?2 AND h.ordinal >= ?5 AND h.model = 1 AND h.visible = 1
       AND (h.superseded_rev IS NULL OR h.superseded_rev >= ?3)
     ORDER BY h.ordinal ASC";

/// The first live row of a turn in `[?2, ?3)` of session `?1`, judged at fork point `?4`: where a run of turn-less rows
/// that starts at `?2` ends. A walk of the log's own order, which stops at that row.
pub(crate) const TURNLESS_RUN_END_SQL: &str = "SELECT ordinal FROM history
     WHERE session = ?1 AND ordinal >= ?2 AND ordinal < ?3 AND turn IS NOT NULL
       AND (superseded_rev IS NULL OR superseded_rev >= ?4)
     ORDER BY ordinal ASC LIMIT 1";

/// `read` with the steps of every statement it runs on `c` counted for the reader's session
/// ([`read_count::take_steps`](crate::read_count::take_steps)): what a read costs its index, whichever statements serve
/// it, as the connection itself reports them.
#[cfg(any(test, feature = "test-support"))]
fn counted<T>(c: &Connection, lineage: &[LineageLevel], read: impl FnOnce(&Connection) -> T) -> T {
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering::Relaxed;

    unsafe extern "C" fn step(steps: *mut std::ffi::c_void) -> std::ffi::c_int {
        // SAFETY: `steps` is the counter registered with this handler, which lives until the handler is removed.
        unsafe { &*steps.cast::<AtomicU64>() }.fetch_add(1, Relaxed);
        0
    }
    struct Removed<'a>(&'a Connection);
    impl Drop for Removed<'_> {
        fn drop(&mut self) {
            // SAFETY: the handle is this open connection's; a progress handler may be removed at any time.
            unsafe { rusqlite::ffi::sqlite3_progress_handler(self.0.handle(), 0, None, std::ptr::null_mut()) };
        }
    }
    let steps = AtomicU64::new(0);
    // SAFETY: the handle is this open connection's, used on this thread alone; SQLite calls `step` with the pointer given
    // here, once per step of a statement's program, only inside the statements `read` runs, and `removed` takes the
    // handler off before `steps` goes, on a panic too. No other progress handler is installed on a reader's connection.
    unsafe { rusqlite::ffi::sqlite3_progress_handler(c.handle(), 1, Some(step), std::ptr::from_ref(&steps).cast_mut().cast()) };
    let removed = Removed(c);
    let out = read(c);
    drop(removed);
    crate::read_count::add_steps(&lineage[0].session, steps.load(Relaxed));
    out
}

#[cfg(not(any(test, feature = "test-support")))]
fn counted<T>(c: &Connection, _lineage: &[LineageLevel], read: impl FnOnce(&Connection) -> T) -> T {
    read(c)
}

type Page = (Vec<HistoryRow>, Option<PageCursor>);

/// The rows of `lineage[level]` a reader sees below `before`: the exclusive ordinal bound (a child sees a base row unless a
/// rewind before the fork point superseded it) and the fork point its liveness is judged at.
fn level_bounds(lineage: &[LineageLevel], cut: Option<u64>, level: usize, before: u64) -> (u64, i64) {
    let fork_end = lineage[level].end;
    let mut before = fork_end.map_or(before, |e| before.min(e));
    if level > 0
        && let Some(cut) = cut
    {
        before = before.min(cut);
    }
    (before, fork_end.map_or(i64::MAX, |e| e as i64))
}

/// The exclusive version bound of a level's amends: the fork point or cut a model context reads the level at ([`crate::context`]), none for the live level.
fn amend_bound(lineage: &[LineageLevel], cut: Option<u64>, level: usize) -> i64 {
    clamp_i64(level_bounds(lineage, cut, level, u64::MAX).0)
}

/// Where the rows older than a row that a client's id names start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryAnchor {
    /// A page from here starts with the oldest row named by `ids` or `alias`, then runs older.
    pub cursor: PageCursor,
    /// How many visible rows `ids` or `alias` name. With several, the one a client's id means depends on how each shows it
    /// (a row's submission id takes the id before another row's item id does), which only the rows themselves tell.
    pub named: u64,
}

/// The oldest visible row of the lineage whose `iid` is one of `ids` or that `alias` names, found by the indexes of `iid` and
/// of aliases, not by a walk of the history; `None` when no row is.
fn anchor_on(c: &Connection, lineage: &[LineageLevel], cut: Option<u64>, ids: &[String], alias: &str) -> Result<Option<HistoryAnchor>, DbError> {
    if ids.is_empty() {
        return Ok(None);
    }
    let rev: i64 = c.prepare_cached("SELECT history_rev FROM sessions WHERE id = ?1")?.query_row([&lineage[0].session], |r| r.get(0)).optional()?.unwrap_or(0);
    let marks = (0..ids.len()).map(|i| format!("?{}", i + 4)).collect::<Vec<_>>().join(",");
    // Both by the id: the index of `iid` is named and the alias table leads its join. Left to itself the planner walks
    // the level's primary key below `?2`, every row of the level, for each of the two.
    let by_iid = format!(
        "SELECT min(h.ordinal), count(*) FROM history h INDEXED BY history_iid
         WHERE h.session = ?1 AND h.iid IN ({marks}) AND h.ordinal < ?2 AND h.visible = 1
         AND (h.superseded_rev IS NULL OR h.superseded_rev >= ?3)"
    );
    let by_alias = "SELECT min(h.ordinal), count(*) FROM history_alias a CROSS JOIN history h ON h.session = a.session AND h.ordinal = a.ordinal
         WHERE a.session = ?1 AND a.alias = ?4 AND h.ordinal < ?2 AND h.visible = 1
         AND (h.superseded_rev IS NULL OR h.superseded_rev >= ?3)";
    let (mut found, mut named) = (None, 0u64);
    // The deepest level is the oldest: its first hit is the oldest row of all.
    for level in (0..lineage.len()).rev() {
        let (before, floor) = level_bounds(lineage, cut, level, u64::MAX);
        let before = before.min(i64::MAX as u64) as i64;
        let session = &lineage[level].session;
        let by_name =
            c.prepare_cached(by_alias)?.query_row(params![session, before, floor, alias], |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, i64>(1)?)))?;
        let mut args: Vec<&dyn rusqlite::ToSql> = vec![session, &before, &floor];
        args.extend(ids.iter().map(|id| id as &dyn rusqlite::ToSql));
        let by_id = c.prepare(&by_iid)?.query_row(args.as_slice(), |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, i64>(1)?)))?;
        named += (by_name.1 + by_id.1) as u64;
        if found.is_none() {
            found = by_name.0.into_iter().chain(by_id.0).min().map(|ordinal| (level, ordinal as u64));
        }
    }
    Ok(found.map(|(level, ordinal)| HistoryAnchor { cursor: PageCursor { history_rev: rev as u64, level, before: ordinal + 1 }, named }))
}

/// [`anchor_on`] over the occurrences of a unit page: the row `ids` or `alias` name, as there; else, with `boundary`,
/// the boundary of the compaction with that `cid` (the newest the reader sees). A page from the cursor starts with the
/// occurrence named, then runs older.
fn unit_anchor_on(
    c: &Connection,
    lineage: &[LineageLevel],
    cut: Option<u64>,
    ids: &[String],
    alias: &str,
    boundary: Option<&str>,
) -> Result<Option<HistoryAnchor>, DbError> {
    if let Some(row) = anchor_on(c, lineage, cut, ids, alias)? {
        return Ok(Some(row));
    }
    let Some(cid) = boundary else { return Ok(None) };
    let rev = history_rev_on(c, lineage)?;
    for level in 0..lineage.len() {
        let (before, floor) = level_bounds(lineage, cut, level, u64::MAX);
        let found: Option<i64> =
            c.prepare_cached(BOUNDARY_NAMED_SQL)?.query_row(params![lineage[level].session, cid, clamp_i64(before), floor], |r| r.get(0)).optional()?;
        if let Some(ordinal) = found {
            return Ok(Some(HistoryAnchor { cursor: PageCursor { history_rev: rev, level, before: ordinal as u64 + 1 }, named: 1 }));
        }
    }
    Ok(None)
}

fn kept_copies(c: &Connection, session: &str, iid: &str, ordinal: u64, floor: i64) -> Result<Vec<KeptCopy>, DbError> {
    let mut copies = c.prepare_cached(KEPT_SQL)?;
    let found = copies.query_map(params![session, iid, ordinal as i64, floor], |k| {
        Ok(KeptCopy {
            compaction: FramePos { ordinal: k.get::<_, i64>(0)? as u64, file_no: k.get(1)?, offset: k.get::<_, i64>(2)? as u64 },
            frame_len: k.get::<_, i64>(3)? as u64,
            idx: k.get(4)?,
        })
    })?;
    let found = found.collect::<Result<_, _>>()?;
    Ok(found)
}

/// The model-switch boundaries anchored on the row: its own log's and each later level's up to its fork point, oldest level first.
fn row_switches(c: &Connection, lineage: &[LineageLevel], level: usize, ordinal: u64, iid: &str) -> Result<Vec<ModelSwitchEntry>, DbError> {
    let mut model_switches = Vec::new();
    for holder in lineage[..=level].iter().rev() {
        let end = holder.end.map_or(i64::MAX, |e| e as i64);
        let mut stmt = c.prepare_cached(MODEL_SWITCHES_SQL)?;
        let found = stmt.query_map(params![holder.session, ordinal as i64, iid, end], |s| {
            Ok(ModelSwitchEntry { provider: s.get(0)?, model_id: s.get(1)?, at: s.get(2)? })
        })?;
        for entry in found {
            model_switches.push(entry?);
        }
    }
    Ok(model_switches)
}

/// The history row of a `PAGE_SQL` row of `lineage[level]`; `frame` is its frame's length and live amend as read.
fn history_row(
    c: &Connection,
    lineage: &[LineageLevel],
    level: usize,
    floor: i64,
    compactions: &mut crate::archive_index::Compactions<'_>,
    r: &rusqlite::Row<'_>,
    frame: (u64, Option<(FramePos, u64)>),
) -> Result<HistoryRow, DbError> {
    let (frame_len, amend) = frame;
    let ordinal = r.get::<_, i64>(0)? as u64;
    let iid: String = r.get(1)?;
    let form = if r.get::<_, i64>(3)? == 1 { Form::Display } else { Form::Message };
    let model: bool = r.get(4)?;
    let facets: Option<String> = r.get(12)?;
    let mut verdict = crate::archive_index::Verdict::default();
    if model
        && form == Form::Message
        && let Some(facets) = facets.and_then(|f| serde_json::from_str::<crate::message_facets::Facets>(&f).ok())
    {
        verdict = compactions.verdict(level, ordinal, &iid, &facets)?;
    }
    let session = &lineage[level].session;
    let kept = if model && form == Form::Message { kept_copies(c, session, &iid, ordinal, floor)? } else { Vec::new() };
    let model_switches = row_switches(c, lineage, level, ordinal, &iid)?;
    Ok(HistoryRow {
        session: session.clone(),
        ordinal,
        iid,
        turn: r.get(2)?,
        form,
        model,
        pos: FramePos { ordinal, file_no: r.get(5)?, offset: r.get::<_, i64>(6)? as u64 },
        frame_len,
        amend,
        archived: verdict.archived,
        dropped_text: verdict.text,
        dropped_calls: verdict.calls,
        kept,
        model_switches,
        end: (r.get::<_, i64>(13)? == 1).then_some(TurnEndForm::Display),
    })
}

/// The history rows of a page read without boundaries.
fn items_of(units: Vec<UnitRow>) -> Vec<HistoryRow> {
    units
        .into_iter()
        .filter_map(|unit| match unit {
            UnitRow::Item(row) => Some(row),
            UnitRow::Boundary(_) => None,
        })
        .collect()
}

fn page_on(c: &Connection, lineage: &[LineageLevel], cut: Option<u64>, cursor: Option<PageCursor>, limit: usize) -> Result<Page, DbError> {
    let (units, next) = unit_page_on(c, lineage, cut, cursor, limit, false)?;
    Ok((items_of(units), next))
}

/// A row's frame length and live amend.
type RowFrame = (u64, Option<(FramePos, u64)>);

/// The frame length and live amend of a `PAGE_SQL` row, and what the two cost a page's byte budget.
fn row_frame(r: &rusqlite::Row<'_>) -> rusqlite::Result<(RowFrame, u64)> {
    let frame_len = r.get::<_, i64>(7)? as u64;
    let amend = match r.get::<_, Option<i64>>(8)? {
        Some(o) => Some((FramePos { ordinal: o as u64, file_no: r.get(9)?, offset: r.get::<_, i64>(10)? as u64 }, r.get::<_, i64>(11)? as u64)),
        None => None,
    };
    Ok(((frame_len, amend), frame_len + amend.map_or(0, |(_, l)| l)))
}

/// One page of occurrences, newest first: the history rows of [`history_page`](SqliteStore::history_page) and, with
/// `boundaries`, the boundary of each compaction that lists a divider, each at its own ordinal among them. A boundary
/// counts for `limit` as a row does and costs the byte budget nothing (its frame is not read). The cursor is the
/// ordinal the next older occurrence lies below, a row's or a boundary's alike.
fn unit_page_on(
    c: &Connection,
    lineage: &[LineageLevel],
    cut: Option<u64>,
    cursor: Option<PageCursor>,
    limit: usize,
    boundaries: bool,
) -> Result<(Vec<UnitRow>, Option<PageCursor>), DbError> {
    let rev = history_rev_on(c, lineage)?;
    let mut cur = match cursor {
        Some(c) if c.history_rev != rev => return Err(DbError::CursorStale),
        Some(c) => c,
        None => PageCursor { history_rev: rev, level: 0, before: u64::MAX },
    };
    let mut out = Vec::new();
    let mut bytes = 0u64;
    let mut compactions = crate::archive_index::Compactions::new(c, lineage, cut);
    while cur.level < lineage.len() && out.len() < limit {
        let level = &lineage[cur.level];
        let (before, floor) = level_bounds(lineage, cut, cur.level, cur.before);
        let want = (limit - out.len()) as i64;
        let marks = if boundaries { boundaries_on(c, lineage, cur.level, (0, clamp_i64(before)), floor, want, true)? } else { Vec::new() };
        let marks_full = marks.len() as i64 == want;
        let mut marks = marks.into_iter().peekable();
        let mut stmt = c.prepare_cached(PAGE_SQL)?;
        let mut rows = stmt.query(params![level.session, clamp_i64(before), floor, want, amend_bound(lineage, cut, cur.level)])?;
        let mut got = 0;
        let mut stopped = false;
        while let Some(r) = rows.next()? {
            got += 1;
            #[cfg(any(test, feature = "test-support"))]
            crate::read_count::add(&lineage[0].session, 1);
            let ordinal = r.get::<_, i64>(0)? as u64;
            // The boundaries newer than the row come before it.
            while out.len() < limit
                && let Some(mark) = marks.next_if(|mark| mark.pos.ordinal > ordinal)
            {
                cur.before = mark.pos.ordinal;
                out.push(UnitRow::Boundary(mark));
            }
            let (frame, cost) = row_frame(r)?;
            if out.len() >= limit || (!out.is_empty() && bytes + cost > PAGE_MAX_BYTES) {
                stopped = true;
                break;
            }
            bytes += cost;
            let row = history_row(c, lineage, cur.level, floor, &mut compactions, r, frame)?;
            cur.before = row.ordinal;
            out.push(UnitRow::Item(row));
        }
        drop(rows);
        if stopped {
            break;
        }
        if (got as i64) < want {
            // No row of the level is left: the boundaries left are older than every row of it.
            while out.len() < limit
                && let Some(mark) = marks.next()
            {
                cur.before = mark.pos.ordinal;
                out.push(UnitRow::Boundary(mark));
            }
            if marks.peek().is_none() && !marks_full {
                cur.level += 1;
                cur.before = u64::MAX;
            }
        }
    }
    let next = (cur.level < lineage.len()).then_some(cur);
    Ok((out, next))
}

fn history_rev_on(c: &Connection, lineage: &[LineageLevel]) -> rusqlite::Result<u64> {
    let rev: i64 = c.prepare_cached("SELECT history_rev FROM sessions WHERE id = ?1")?.query_row([&lineage[0].session], |r| r.get(0)).optional()?.unwrap_or(0);
    Ok(rev as u64)
}

/// [`page_on`] from the other end: the rows from `cursor` on, oldest first (the deepest level is the oldest), under the
/// same row and byte limits.
fn page_after_on(
    c: &Connection,
    lineage: &[LineageLevel],
    cut: Option<u64>,
    cursor: Option<AfterCursor>,
    limit: usize,
) -> Result<(Vec<HistoryRow>, Option<AfterCursor>), DbError> {
    let (units, next) = unit_page_after_on(c, lineage, cut, cursor, limit, false)?;
    Ok((items_of(units), next))
}

/// [`unit_page_on`] from the other end: the occurrences from `cursor` on, oldest first, under the same limits.
fn unit_page_after_on(
    c: &Connection,
    lineage: &[LineageLevel],
    cut: Option<u64>,
    cursor: Option<AfterCursor>,
    limit: usize,
    boundaries: bool,
) -> Result<(Vec<UnitRow>, Option<AfterCursor>), DbError> {
    let rev = history_rev_on(c, lineage)?;
    let mut cur = match cursor {
        Some(c) if c.history_rev != rev => return Err(DbError::CursorStale),
        Some(c) => c,
        None => AfterCursor { history_rev: rev, level: lineage.len() - 1, from: 0 },
    };
    let mut out = Vec::new();
    let mut bytes = 0u64;
    let mut compactions = crate::archive_index::Compactions::new(c, lineage, cut);
    let mut left = true;
    while left && out.len() < limit {
        let level = &lineage[cur.level];
        let (before, floor) = level_bounds(lineage, cut, cur.level, u64::MAX);
        let want = (limit - out.len()) as i64;
        let marks = if boundaries { boundaries_on(c, lineage, cur.level, (clamp_i64(cur.from), clamp_i64(before)), floor, want, false)? } else { Vec::new() };
        let marks_full = marks.len() as i64 == want;
        let mut marks = marks.into_iter().peekable();
        let mut stmt = c.prepare_cached(PAGE_AFTER_SQL)?;
        let mut rows = stmt.query(params![level.session, clamp_i64(before), floor, want, clamp_i64(cur.from), amend_bound(lineage, cut, cur.level)])?;
        let mut got = 0;
        let mut stopped = false;
        while let Some(r) = rows.next()? {
            got += 1;
            #[cfg(any(test, feature = "test-support"))]
            crate::read_count::add(&lineage[0].session, 1);
            let ordinal = r.get::<_, i64>(0)? as u64;
            // The boundaries older than the row come before it.
            while out.len() < limit
                && let Some(mark) = marks.next_if(|mark| mark.pos.ordinal < ordinal)
            {
                cur.from = mark.pos.ordinal + 1;
                out.push(UnitRow::Boundary(mark));
            }
            let (frame, cost) = row_frame(r)?;
            if out.len() >= limit || (!out.is_empty() && bytes + cost > PAGE_MAX_BYTES) {
                stopped = true;
                break;
            }
            bytes += cost;
            let row = history_row(c, lineage, cur.level, floor, &mut compactions, r, frame)?;
            cur.from = row.ordinal + 1;
            out.push(UnitRow::Item(row));
        }
        drop(rows);
        if stopped {
            break;
        }
        if (got as i64) < want {
            // No row of the level is left: the boundaries left are newer than every row of it.
            while out.len() < limit
                && let Some(mark) = marks.next()
            {
                cur.from = mark.pos.ordinal + 1;
                out.push(UnitRow::Boundary(mark));
            }
            if marks.peek().is_none() && !marks_full {
                match cur.level.checked_sub(1) {
                    Some(newer) => (cur.level, cur.from) = (newer, 0),
                    None => left = false,
                }
            }
        }
    }
    Ok((out, left.then_some(cur)))
}

/// The live replacement copies (oldest compaction first) of message `?2` written after its
/// row at `?3`, as of `?4` (the fork point, else `i64::MAX`). The index is named: left to itself the planner walks the
/// primary key from `?3` to the session's end, every message row every later compaction kept, for each history row.
pub(crate) const KEPT_SQL: &str = "SELECT c.ordinal, c.file_no, c.frame_offset, c.frame_len, m.idx
     FROM message_rows m INDEXED BY message_rows_iid
     JOIN compactions c ON c.session = m.session AND c.ordinal = m.ordinal
     WHERE m.session = ?1 AND m.iid = ?2 AND m.ordinal > ?3 AND m.ordinal < ?4 AND m.ver = m.ordinal
       AND (m.superseded_rev IS NULL OR m.superseded_rev >= ?4)
       AND (c.superseded_rev IS NULL OR c.superseded_rev >= ?4) ORDER BY m.ordinal";

/// The model-switch boundaries in session `?1`'s log below `?4` anchored on row `?2` with
/// iid `?3`, in record order. The anchor's index is named, here and below: the planner otherwise walks every switch of
/// the session below `?4`, for each row asked about.
pub(crate) const MODEL_SWITCHES_SQL: &str = "SELECT provider, model_id, at FROM model_switches INDEXED BY model_switches_anchor
     WHERE session = ?1 AND anchor_ordinal = ?2 AND anchor_iid = ?3 AND ordinal < ?4 ORDER BY ordinal";

/// The model-switch boundaries in session `?1`'s log below `?4` anchored on a replacement
/// entry of session `?3`'s `compacted` frame at `?2`, with the entry's position.
pub(crate) const ENTRY_SWITCHES_SQL: &str = "SELECT min(m.idx), s.ordinal, s.provider, s.model_id, s.at
     FROM model_switches s INDEXED BY model_switches_anchor JOIN message_rows m ON m.session = ?3 AND m.ordinal = s.anchor_ordinal
       AND m.iid = s.anchor_iid
     WHERE s.session = ?1 AND s.anchor_ordinal = ?2 AND s.ordinal < ?4 GROUP BY s.ordinal";

/// One history page level: visible rows below `?2`, live for the reader at `?3`.
pub(crate) const PAGE_SQL: &str = "SELECT h.ordinal, h.iid, h.turn, h.form, h.model, h.file_no, h.frame_offset, h.frame_len,
       a.ordinal, a.file_no, a.frame_offset, a.frame_len,
       h.facets, h.end_form
     FROM history h LEFT JOIN amends a ON a.session = h.session AND a.ordinal = (SELECT max(x.ordinal) FROM amends x WHERE x.session = h.session
       AND x.target_ordinal = h.ordinal AND x.ordinal < ?5 AND (x.superseded_rev IS NULL OR x.superseded_rev >= ?5))
     WHERE h.session = ?1 AND h.ordinal < ?2 AND h.visible = 1
       AND (h.superseded_rev IS NULL OR h.superseded_rev >= ?3)
     ORDER BY h.ordinal DESC LIMIT ?4";

/// The visible model rows of turn `?4` below `?2` of a level, live for the reader at `?3`. The index is named: it is the
/// one whose cost is the turn's rows, and a plan over the level's rows is the cost this statement must never have.
pub(crate) const TURN_MESSAGES_SQL: &str = "SELECT h.ordinal, h.iid, h.form, h.facets FROM history h INDEXED BY history_turn
     WHERE h.session = ?1 AND h.turn = ?4 AND h.ordinal < ?2 AND h.model = 1 AND h.visible = 1
       AND (h.superseded_rev IS NULL OR h.superseded_rev >= ?3)";

/// [`PAGE_SQL`] the other way: the level's visible rows from `?5` on, oldest first.
pub(crate) const PAGE_AFTER_SQL: &str = "SELECT h.ordinal, h.iid, h.turn, h.form, h.model, h.file_no, h.frame_offset, h.frame_len,
       a.ordinal, a.file_no, a.frame_offset, a.frame_len,
       h.facets, h.end_form
     FROM history h LEFT JOIN amends a ON a.session = h.session AND a.ordinal = (SELECT max(x.ordinal) FROM amends x WHERE x.session = h.session
       AND x.target_ordinal = h.ordinal AND x.ordinal < ?6 AND (x.superseded_rev IS NULL OR x.superseded_rev >= ?6))
     WHERE h.session = ?1 AND h.ordinal < ?2 AND h.ordinal >= ?5 AND h.visible = 1
       AND (h.superseded_rev IS NULL OR h.superseded_rev >= ?3)
     ORDER BY h.ordinal ASC LIMIT ?4";

pub(crate) const PROJECTED_SQL: &str = "SELECT projected_ordinal, projected_file_no, projected_offset FROM sessions WHERE id = ?1";

pub(crate) const THREAD_OP_SQL: &str = "SELECT method, payload_digest, state, ordinal, file_no, frame_offset,
     frame_len FROM thread_ops WHERE session = ?1 AND op_id = ?2";

/// The newest live occurrence of one prompt key.
pub(crate) const PROMPT_NEWEST_SQL: &str = "SELECT ordinal, text FROM prompt_occurrences
     WHERE session = ?1 AND key = ?2 AND superseded_rev IS NULL ORDER BY ordinal DESC LIMIT 1";

/// 1.4.5 `PROMPT_HISTORY_LIMIT`.
pub const PROMPT_HISTORY_LIMIT: usize = 50;

/// The newest distinct prompts of one session, newest first.
pub(crate) const PROMPTS_SQL: &str = "SELECT key, text FROM prompt_history WHERE session = ?1 ORDER BY ordinal DESC LIMIT ?2";

/// A base level's prompt occurrences below `?2`, live for a fork at `?3`, newest first;
/// read until the lineage has 50 distinct keys.
pub(crate) const BASE_PROMPTS_SQL: &str = "SELECT key, text FROM prompt_occurrences
     WHERE session = ?1 AND ordinal < ?2 AND (superseded_rev IS NULL OR superseded_rev >= ?3)
     ORDER BY ordinal DESC";

pub(crate) const LIVE_ROWS_SQL: &str = "SELECT count(*), coalesce(sum(visible), 0) FROM history
     WHERE session = ?1 AND ordinal >= ?2 AND ordinal < ?3 AND superseded_rev IS NULL";

pub(crate) const LIVE_COMPACTION_SQL: &str = "SELECT ordinal, file_no, frame_offset FROM compactions
     WHERE session = ?1 AND ordinal < ?2 AND superseded_rev IS NULL ORDER BY ordinal DESC LIMIT 1";

/// `(sql, ?1, limit)` of a session search (FORMAT.md §8.2); `?3..?5` are the keyset. Its rows are `(summary, withheld)`.
pub(crate) fn search_statement(query: &str, limit: usize) -> (String, String, usize) {
    let needle = fold(query.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'));
    let keyset = "(?3 IS NULL OR s.archived > ?3 OR (s.archived = ?3 AND (s.activity < ?4
        OR (s.activity = ?4 AND s.id_key > ?5))))";
    let held = "EXISTS (SELECT 1 FROM withheld_sessions w WHERE w.id = s.id)";
    let len = needle.chars().count();
    let (sql, limit) = match len {
        0 => (
            format!(
                "SELECT s.summary, {held} FROM sessions s WHERE s.deleted = 0 AND s.classification IN ('task','project')
                 AND s.archived = 0 AND ?1 = ?1 AND {keyset}
                 ORDER BY s.archived, s.activity DESC, s.id_key LIMIT ?2"
            ),
            limit.min(RECENT_SESSION_ROWS),
        ),
        1 | 2 => (
            format!(
                "SELECT s.summary, 0 FROM sessions s WHERE s.deleted = 0 AND s.classification IN ('task','project')
                 AND (instr(s.title_fold, ?1) OR instr(s.preview_fold, ?1) OR instr(s.cwd_fold, ?1)
                   OR instr(s.project_fold, ?1) OR instr(s.id_fold, ?1) OR instr(s.model_fold, ?1)
                   OR instr(s.source_fold, ?1)) AND {keyset} AND NOT {held}
                 ORDER BY s.archived, s.activity DESC, s.id_key LIMIT ?2"
            ),
            limit,
        ),
        _ => (
            format!(
                "SELECT s.summary, 0 FROM session_search f JOIN sessions s ON s.sid = f.rowid
                 WHERE session_search MATCH ?1 AND s.deleted = 0 AND s.classification IN ('task','project')
                 AND {keyset} AND NOT {held} ORDER BY s.archived, s.activity DESC, s.id_key LIMIT ?2"
            ),
            limit,
        ),
    };
    let arg = if len >= 3 { format!("\"{}\"", needle.replace('"', "\"\"")) } else { needle };
    (sql, arg, limit)
}

fn projected_on(c: &Connection, session: &str) -> Result<Option<FramePos>, DbError> {
    Ok(c.prepare_cached(PROJECTED_SQL)?
        .query_row([session], |r| Ok(FramePos { ordinal: r.get::<_, i64>(0)? as u64, file_no: r.get(1)?, offset: r.get::<_, i64>(2)? as u64 }))
        .optional()?)
}

fn thread_op_on(c: &Connection, session: &str, op_id: &str) -> Result<Option<ThreadOp>, DbError> {
    Ok(c.prepare_cached(THREAD_OP_SQL)?
        .query_row([session, op_id], |r| {
            let state: String = r.get(2)?;
            Ok(ThreadOp {
                method: r.get(0)?,
                payload_digest: r.get(1)?,
                state: serde_json::from_value(serde_json::Value::String(state))
                    .map_err(|e| rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e)))?,
                pos: FramePos { ordinal: r.get::<_, i64>(3)? as u64, file_no: r.get(4)?, offset: r.get::<_, i64>(5)? as u64 },
                frame_len: r.get::<_, i64>(6)? as u64,
            })
        })
        .optional()?)
}

fn submission_on(c: &Connection, session: &str, submission: &str) -> Result<Option<serde_json::Value>, DbError> {
    let answer: Option<String> = c
        .prepare_cached("SELECT answer FROM submissions WHERE session = ?1 AND submission_id = ?2")?
        .query_row([session, submission], |r| r.get(0))
        .optional()?;
    answer.map(|answer| serde_json::from_str(&answer).map_err(|e| DbError::Rebuild(format!("a stored submission answer does not parse: {e}")))).transpose()
}

fn fenced_ops_on(c: &Connection, session: &str) -> Result<Vec<String>, DbError> {
    let fenced = serde_name(&crate::schema::record::OpState::Fenced);
    let mut rows = c.prepare_cached("SELECT op_id FROM thread_ops WHERE session = ?1 AND state = ?2")?;
    let ids = rows.query_map([session, fenced.as_str()], |r| r.get::<_, String>(0))?;
    Ok(ids.collect::<Result<Vec<_>, _>>()?)
}

pub(crate) struct ReadPool {
    path: PathBuf,
    lane: InteractiveIo,
    conns: Mutex<Vec<Connection>>,
    /// `true` once [`close`](Self::close) has run. Every read holds it shared from before it takes or opens a connection until
    /// that connection is back or closed, and `close` takes it exclusively, so `close` waits for the reads in flight and no read
    /// opens a connection after it returned. A pool nobody closes keeps its connections until the last owner of the store drops it.
    closed: std::sync::RwLock<bool>,
}

impl ReadPool {
    pub(crate) fn new(path: &Path, lane: InteractiveIo) -> Arc<ReadPool> {
        Arc::new(ReadPool { path: path.to_path_buf(), lane, conns: Mutex::new(Vec::new()), closed: std::sync::RwLock::new(false) })
    }

    /// Waits for the reads in flight, closes every pooled connection, and makes every later read fail as the stopped writer
    /// does (a test's data folder, and the exec's private root, are removed while the process lives on).
    pub(crate) fn close(&self) {
        let mut closed = self.closed.write().unwrap_or_else(std::sync::PoisonError::into_inner);
        *closed = true;
        self.conns.lock().expect("pool lock").clear();
    }

    pub(crate) fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T, DbError>) -> Result<T, DbError> {
        let closed = self.closed.read().unwrap_or_else(std::sync::PoisonError::into_inner);
        if *closed {
            return Err(DbError::Stopped);
        }
        let conn = self.conns.lock().expect("pool lock").pop();
        let conn = match conn {
            Some(c) => c,
            None => open_connection(&self.path)?,
        };
        let out = f(&conn);
        let mut pool = self.conns.lock().expect("pool lock");
        if pool.len() < READ_POOL {
            pool.push(conn);
        }
        out
    }

    pub(crate) fn run<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&Connection) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, DbError>> + Send + 'static {
        self.run_in_lane(move |_, c| f(c))
    }

    /// [`run`](Self::run) for a read that also touches files: the job gets the lane proof.
    pub(crate) fn run_in_lane<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&InLane<InteractiveIo>, &Connection) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, DbError>> + Send + 'static {
        let pool = self.clone();
        let lane = self.lane;
        async move {
            let cancel = CancellationToken::new();
            let job = lane.submit_wait(&cancel, move |lane| pool.with(|c| f(lane, c))).await.map_err(lane_unrun)?;
            job.await.map_err(lane_lost)?
        }
    }
}

impl LineageIndex for SqliteStore {
    fn live_rows(&self, session: &str, from: u64, to: u64) -> Result<(u64, u64), LookupError> {
        self.with_of(&[session], |c| {
            let projected = projected_on(c, session)?.map_or(0, |p| p.ordinal);
            if projected < to {
                return Ok(Err(LookupError::Behind { projected, needed: to }));
            }
            Ok(Ok(c
                .prepare_cached(LIVE_ROWS_SQL)?
                .query_row(params![session, from as i64, to as i64], |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64)))?))
        })?
    }

    fn live_compaction_before(&self, session: &str, before: u64) -> Result<Option<FramePos>, LookupError> {
        self.with_of(&[session], |c| {
            let projected = projected_on(c, session)?.map_or(0, |p| p.ordinal);
            if projected < before {
                return Ok(Err(LookupError::Behind { projected, needed: before }));
            }
            Ok(Ok(c
                .prepare_cached(LIVE_COMPACTION_SQL)?
                .query_row(params![session, before as i64], |r| {
                    Ok(FramePos { ordinal: r.get::<_, i64>(0)? as u64, file_no: r.get(1)?, offset: r.get::<_, i64>(2)? as u64 })
                })
                .optional()?))
        })?
    }
}
