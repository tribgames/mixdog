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

#[cfg(test)]
mod batch_tests;
mod gate;
pub mod lead;
pub mod listing;
#[cfg(test)]
mod model_tests;
#[cfg(test)]
mod purge_tests;
mod withheld;
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

/// SPEC R31 append transaction bounds.
pub const APPEND_ROWS: usize = 512;
pub const APPEND_BYTES: usize = 1 << 20;
/// SPEC R31 maintenance step bound.
pub const STEP_ROWS: usize = 500;
/// SPEC R31: `wal_checkpoint(PASSIVE)` once the WAL holds this many pages.
pub const WAL_CHECKPOINT_PAGES: i32 = 1000;
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
    /// The read lane's queue is full; the caller retries or reports busy.
    /// A lane refused the job as overloaded (its queue at the far bound, or no healthy worker);
    /// below that bound the job waits for a thread.
    #[error("overloaded: lane")]
    LaneFull,
    /// The history changed (a rewind) since the cursor was issued.
    #[error("history cursor is stale")]
    CursorStale,
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
            wal.checkpoint_v2(rusqlite::wal::CheckpointMode::PASSIVE)?;
        }
        Ok(())
    }))?;
    Ok(conn)
}

/// How long [`truncate_wal`] lets SQLite's busy handler wait for the readers of older WAL frames.
const TRUNCATE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// `wal_checkpoint(TRUNCATE)`: every WAL frame into the database, then the WAL emptied. A reader's snapshot holds
/// the frames it may still read, so SQLite's busy handler waits for those readers (each read job is one bounded
/// query), up to [`TRUNCATE_WAIT`]; the connection's own zero timeout is put back after.
fn truncate_wal(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(TRUNCATE_WAIT).map_err(|e| e.to_string())?;
    let busy = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get::<_, i64>(0));
    conn.busy_timeout(std::time::Duration::ZERO).map_err(|e| e.to_string())?;
    match busy.map_err(|e| e.to_string())? {
        0 => Ok(()),
        _ => Err(format!("the index WAL stayed in use by readers for {} s; it is truncated at the next attempt", TRUNCATE_WAIT.as_secs())),
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
/// Projects every session of `data` into a staged database and publishes it over `path`.
/// The old file's WAL and shared memory go first, so they never pair with the new file; a
/// crash before the publish leaves a file that still fails its open and rebuilds again.
#[allow(clippy::disallowed_methods, reason = "runs on the maintenance lane job (lane proof argument)")]
fn rebuild(_lane: &InLane<MaintenanceIo>, data: &Path, path: &Path, sessions: &[String], progress: Option<&RebuildProgress>) -> Result<(), DbError> {
    let failed = |e: String| DbError::Write(format!("index rebuild: {e}"));
    let dir = path.parent().expect("index file in a directory");
    crate::fsio::create_dir_durable(dir).map_err(|e| failed(e.to_string()))?;
    crate::fsio::sweep_tmp_unlaned(dir).map_err(|e| failed(e.to_string()))?;
    let staged = crate::fsio::tmp_path(path);
    project_into(data, &staged, sessions, &runtime_ddl(), progress).map_err(failed)?;
    let whole = std::fs::OpenOptions::new().read(true).write(true).open(&staged).map_err(|e| failed(e.to_string()))?;
    crate::fsio::sync_file(&whole, &staged).map_err(|e| failed(e.to_string()))?;
    drop(whole);
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

/// Writes the catalog row of `head` with the message state projected so far; the bytes
/// of the list row.
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
    let before = if watch {
        tx.prepare_cached("SELECT summary, archived, deleted, user_name FROM sessions WHERE id = ?1")?
            .query_row([&row.id], |r| Ok(StoredRow { summary: r.get(0)?, archived: r.get(1)?, deleted: r.get(2)?, user_name: r.get(3)? }))
            .optional()?
    } else {
        None
    };
    write_row(tx, &row, dirty, labels)?;
    tx.prepare_cached("DELETE FROM archived_agents WHERE session = ?1")?.execute([&head.session])?;
    for child in crate::archived_agent::children(&head.header) {
        tx.prepare_cached("INSERT INTO archived_agents (session, child) VALUES (?1, ?2)")?.execute([&head.session, &child])?;
    }
    let after = StoredRow { summary: row.summary.clone(), archived: row.archived, deleted: row.deleted, user_name: row.user_name.clone() };
    let edge = (watch && before.as_ref() != Some(&after)).then(|| RowEdge { id: row.id.clone(), before, after });
    Ok((row.summary.len(), edge))
}

/// The session's reference set and copy mark as its header holds them now (`offload_sources`). A header holding a set
/// makes the session known under the present rules and its set the rows; one holding none, or one of earlier rules
/// (whose rows join), leaves it unknown but for a scan of its transcript at the ordinal it is projected to under the
/// present rules (`offload_known`), and leaves the rows it had (a set only grows).
fn write_offload_refs(tx: &Transaction<'_>, head: &CatalogHead) -> rusqlite::Result<()> {
    use crate::offload_sources as sets;
    tx.prepare_cached("DELETE FROM offload_marks WHERE session = ?1")?.execute([&head.session])?;
    if let Some((source, boot)) = sets::mark(&head.header) {
        tx.prepare_cached("INSERT INTO offload_marks (session, source, boot) VALUES (?1, ?2, ?3)")?.execute(params![head.session, source, boot])?;
    }
    if sets::holds_set(&head.header) {
        tx.prepare_cached("DELETE FROM offload_refs WHERE session = ?1")?.execute([&head.session])?;
        for source in sets::sources(&head.header) {
            tx.prepare_cached("INSERT OR IGNORE INTO offload_refs (source, session) VALUES (?1, ?2)")?
                .execute(params![sets::segment_key(&source), head.session])?;
        }
        tx.prepare_cached("INSERT INTO offload_known (session, ordinal, rules) VALUES (?1, NULL, ?2) ON CONFLICT(session) DO UPDATE SET ordinal = NULL, rules = excluded.rules")?
            .execute(params![head.session, sets::RULES])?;
    } else {
        for source in sets::sources(&head.header) {
            tx.prepare_cached("INSERT OR IGNORE INTO offload_refs (source, session) VALUES (?1, ?2)")?
                .execute(params![sets::segment_key(&source), head.session])?;
        }
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
    if current != Some(ordinal) || from_header {
        return Ok(());
    }
    for source in sources {
        tx.prepare_cached("INSERT OR IGNORE INTO offload_refs (source, session) VALUES (?1, ?2)")?.execute(params![sets::segment_key(source), session])?;
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
    MarkDirty {
        session: String,
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
    /// Rebuild a session's rows from its rewritten log ([`Writer::reproject`]).
    Reproject {
        rewrite: Rewritten,
        ack: Ack,
    },
    /// Frames of a session the reconcile read from its log; with `finish`, its row and damage,
    /// written clean (`reconcile`). Answered on a channel the lane job blocks on.
    Reconcile {
        session: String,
        frames: Vec<ProjectedFrame>,
        finish: Option<Box<(CatalogHead, Option<String>)>>,
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

/// A projection being applied: frames before `next` are committed.
struct Pending {
    projection: Projection,
    next: usize,
    ack: Option<Ack>,
    /// Arrival order among projections and upserts.
    seq: u64,
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
    /// Sessions whose rows are rebuilt from a rewritten log, once the projections queued before are in.
    reprojects: VecDeque<(Rewritten, Ack, u64)>,
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
}

const LABELS_KEY: &str = "ui:placeholder_labels";
const REFOLD_JOB: &str = "job:refold_titles";

/// The seam of the boot reconcile between a session's projection and its row: a test arms it
/// for one data dir, and the next reconcile there ends (as a process ending at that point).
#[cfg(test)]
pub(crate) mod reconcile_seam {
    use std::path::Path;
    use std::path::PathBuf;
    use std::sync::Mutex;

    static ARMED: Mutex<Option<PathBuf>> = Mutex::new(None);
    static FAILING: Mutex<Option<PathBuf>> = Mutex::new(None);
    static HELD: Mutex<Option<(PathBuf, std::sync::mpsc::Receiver<()>)>> = Mutex::new(None);

    pub(crate) fn arm(data: &Path) {
        *ARMED.lock().expect("seam") = Some(data.to_path_buf());
    }

    /// The next reconcile in `data` starts once the returned sender sends (or is dropped).
    pub(crate) fn hold(data: &Path) -> std::sync::mpsc::Sender<()> {
        let (release, held) = std::sync::mpsc::channel();
        *HELD.lock().expect("seam") = Some((data.to_path_buf(), held));
        release
    }

    pub(super) fn wait_if_held(data: &Path) {
        let mut slot = HELD.lock().expect("seam");
        if slot.as_ref().is_some_and(|(at, _)| at == data) {
            let (_, held) = slot.take().expect("held");
            drop(slot);
            let _ = held.recv();
        }
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

    pub(super) fn ends_here(data: &Path) -> bool {
        let mut armed = ARMED.lock().expect("seam");
        let hit = armed.as_deref() == Some(data);
        if hit {
            *armed = None;
        }
        hit
    }
}

fn send(acks: Vec<Ack>, result: &Result<(), String>) {
    for ack in acks {
        let _ = ack.send(result.clone().map_err(DbError::Write));
    }
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
            reprojects: VecDeque::new(),
            seq: 0,
            archive_reads: Arc::default(),
            append_rows: APPEND_ROWS,
            step_rows: STEP_ROWS,
            sink: RowSinkCell::default(),
            archive: ArchiveCell::default(),
        })
    }

    fn take(&mut self, cmd: Command) {
        self.seq += 1;
        let seq = self.seq;
        match cmd {
            // Applied as it arrives: every other request waits until the reconcile is done.
            Command::Reconcile { session, frames, finish, ack } => {
                let _ = ack.send(self.reconcile_apply(&session, &frames, finish.map(|finish| *finish)));
            }
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
                self.projections.push_back(Pending { projection, next: 0, ack, seq });
            }
            Command::Purge { session, ack } => self.purges.push_back((session, ack)),
            Command::Reproject { rewrite, ack } => self.reprojects.push_back((rewrite, ack, seq)),
            other => self.small.push_back(other),
        }
    }

    fn idle(&self) -> bool {
        self.upserts.is_empty()
            && self.small.is_empty()
            && self.projections.is_empty()
            && !self.refold
            && !self.views
            && self.purges.is_empty()
            && self.reprojects.is_empty()
    }

    /// The rows of `session` rebuilt from its log, as a rebuild projects them (`project_session`), after its log was
    /// rewritten to take a value out (`log_rewrite`): the old rows go with the writer's `secure_delete`, so their content
    /// is overwritten in the pages that held it, and the WAL is checkpointed and truncated after, so no older page image
    /// of them is left in it either.
    fn reproject(&mut self, rewrite: &Rewritten) -> Result<(), String> {
        let Rewritten { data, session, dirty } = rewrite;
        let (data, session, dirty) = (data.as_path(), session.as_str(), *dirty);
        let labels = self.labels.clone();
        let rows = (|| -> Result<(), String> {
            while !self.purge_rows(session).map_err(|e| e.to_string())? {}
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
            tx.commit().map_err(|e| e.to_string())
        })();
        // A fork view over these rows settles in the maintenance steps.
        self.views = true;
        rows.and_then(|()| truncate_wal(&self.conn))
    }

    /// Every queued rebuild, once no projection is queued before it. Projections queued after it (other threads' writes go on
    /// meanwhile) do not hold it back: the log's own reads wait on the rebuild.
    fn reproject_step(&mut self) {
        while let Some(&(_, _, seq)) = self.reprojects.front()
            && self.projections.front().is_none_or(|pending| pending.seq > seq)
        {
            let (rewrite, ack, _) = self.reprojects.pop_front().expect("the front rebuild");
            let result = self.reproject(&rewrite);
            let _ = ack.send(result.map_err(DbError::Write));
        }
    }

    /// One bounded step of purging `session`'s index rows: at most `step_rows` deletions,
    /// its fork edge (one per child) and catalog row counted, those two last. `true` once
    /// the catalog row is gone.
    fn purge_rows(&mut self, session: &str) -> rusqlite::Result<bool> {
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut budget = self.step_rows;
        for (table, key) in PURGE_TABLES {
            let sql = format!("DELETE FROM {table} WHERE ({key}) IN (SELECT {key} FROM {table} WHERE session = ?1 LIMIT ?2)");
            budget -= tx.prepare_cached(&sql)?.execute(params![session, budget as i64])?;
            if budget == 0 {
                tx.commit()?;
                return Ok(false);
            }
        }
        budget -= tx.prepare_cached("DELETE FROM fork_edges WHERE child = ?1")?.execute([session])?;
        if budget == 0 {
            tx.commit()?;
            return Ok(false);
        }
        tx.prepare_cached("DELETE FROM sessions WHERE id = ?1")?.execute([session])?;
        tx.commit()?;
        Ok(true)
    }

    /// The boot purge, run by `SqliteStore::open` before the writer thread starts (so before
    /// any thread opens or is created): the index rows of `incomplete` (folders
    /// `scan_session_dirs` removed), then every deleted session no fork reads, folder
    /// first (`purge_deleted`'s order), in bounded steps.
    fn boot_purge(&mut self, lane: &InLane<MaintenanceIo>, data: &Path, incomplete: &[String]) -> Result<(), DbError> {
        for session in incomplete {
            while !self.purge_rows(session)? {}
        }
        loop {
            let next = self.conn.prepare_cached(PURGEABLE_SQL)?.query_row([], |r| r.get::<_, String>(0)).optional()?;
            let Some(session) = next else { return Ok(()) };
            remove_session_dir(lane, &data.join("sessions").join(&session))?;
            while !self.purge_rows(&session)? {}
        }
    }

    /// One message of the reconcile (`reconcile`): the frames, then with `finish` the row
    /// (and damage) of the session, which clears its dirty mark in the row's transaction.
    fn reconcile_apply(&mut self, session: &str, frames: &[ProjectedFrame], finish: Option<(CatalogHead, Option<String>)>) -> Result<(), DbError> {
        apply_all(&mut self.conn, session, frames)?;
        let Some((head, damage)) = finish else { return Ok(()) };
        let archive = bound_archive(&self.archive);
        let tx = self.conn.transaction()?;
        upsert(&tx, &head, DirtyMark::Clear, &self.labels, archive.as_deref())?;
        if let Some(damage) = damage {
            set_status_on(&tx, session, SessionStatus::Damaged, Some(&damage))?;
        }
        tx.commit()?;
        // A fork whose base gained rows may now have a view to finish.
        self.views = true;
        Ok(())
    }

    /// One bounded step of the oldest purge (`purge_rows`).
    fn purge_step(&mut self) {
        let Some((session, _)) = self.purges.front() else { return };
        let session = session.clone();
        let step = self.purge_rows(&session);
        match step {
            Ok(false) => {}
            Ok(true) => {
                let (_, ack) = self.purges.pop_front().expect("front");
                let _ = ack.send(Ok(()));
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
            Ok(crate::message_index::Step::Idle) => self.views = false,
            Err(e) => {
                debug_assert!(false, "view step failed: {e}");
                self.views = false;
            }
        }
    }

    fn run(mut self, rx: mpsc::Receiver<Command>) {
        loop {
            if self.idle() {
                match rx.recv() {
                    Ok(cmd) if cmd.closes() => return,
                    Ok(cmd) => self.take(cmd),
                    Err(_) => return,
                }
            }
            while let Ok(cmd) = rx.try_recv() {
                if cmd.closes() {
                    return;
                }
                self.take(cmd);
            }
            self.append_transaction();
            if self.refold {
                self.maintenance_step();
            }
            if self.views {
                self.view_step();
            }
            self.purge_step();
            self.reproject_step();
        }
    }

    /// One append transaction within the R31 bounds.
    fn append_transaction(&mut self) {
        if self.upserts.is_empty() && self.small.is_empty() && self.projections.is_empty() {
            return;
        }
        let mut acks = Vec::new();
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
        let result =
            (|| -> rusqlite::Result<()> {
                let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                // Small commands (dirty marks, status): one row each.
                while rows < self.append_rows
                    && let Some(cmd) = self.small.pop_front()
                {
                    rows += 1;
                    match cmd {
                        Command::MarkDirty { session, ack } => {
                            tx.prepare_cached("UPDATE sessions SET dirty = 1 WHERE id = ?1")?.execute([&session])?;
                            acks.push(ack);
                        }
                        Command::Status { session, status, damage, ack } => {
                            set_status_on(&tx, &session, status, damage.as_deref())?;
                            acks.push(ack);
                        }
                        Command::Delete { session, ack } => {
                            tx.prepare_cached("UPDATE sessions SET deleted = 1, dirty = 0 WHERE id = ?1")?.execute([&session])?;
                            acks.push(ack);
                        }
                        Command::Labels { labels, ack } => {
                            let json = serde_json::to_string(&[&labels.image, &labels.video, &labels.file]).expect("labels encode");
                            let mut meta =
                                tx.prepare_cached("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")?;
                            meta.execute([LABELS_KEY, json.as_str()])?;
                            meta.execute([REFOLD_JOB, "0"])?;
                            self.labels = labels;
                            self.refold = true;
                            acks.push(ack);
                        }
                        Command::OffloadScan { session, ordinal, sources, ack } => {
                            record_offload_scan(&tx, &session, ordinal, &sources)?;
                            acks.push(ack);
                        }
                        Command::Arrived { session, log_id, base_session, ack } => {
                            tx.prepare_cached("UPDATE sessions SET log_id = ?2, base_session = ?3, dirty = 1 WHERE id = ?1 AND log_id = ?4")?
                                .execute(params![session, log_id, base_session, PENDING_LOG_ID])?;
                            acks.push(ack);
                        }
                        Command::Pending { sessions, ack } => {
                            // One transaction for them all: they are listed once, before the first client reads the list.
                            for (head, stats) in &sessions {
                                // A row there is (taken in already, or listed by an earlier start) is left as it is.
                                if !tx.prepare_cached("SELECT 1 FROM sessions WHERE id = ?1")?.exists([&head.session])? {
                                    let mut row = crate::summary::catalog_row(head, stats, now_ms());
                                    resolve_archive(&mut row, archive.as_deref());
                                    write_row(&tx, &row, DirtyMark::Clear, &self.labels)?;
                                }
                            }
                            acks.push(ack);
                        }
                        Command::Archive { sessions, read, ack } => {
                            read.store(read_seq, std::sync::atomic::Ordering::SeqCst);
                            for session in &sessions {
                                let Some(entry) = archive.as_deref().and_then(|archive| archive.entry(session)) else { continue };
                                let archived_at = entry.archived_at();
                                let before = tx
                                    .prepare_cached("SELECT summary, archived, deleted, user_name FROM sessions WHERE id = ?1")?
                                    .query_row([session], |r| {
                                        Ok(StoredRow { summary: r.get(0)?, archived: r.get(1)?, deleted: r.get(2)?, user_name: r.get(3)? })
                                    })
                                    .optional()?;
                                let changed = tx
                                    .prepare_cached(
                                        "UPDATE sessions SET archived = ?2, archived_at = ?3 WHERE id = ?1 AND (archived <> ?2 OR archived_at IS NOT ?3)",
                                    )?
                                    .execute(params![session, archived_at.is_some(), archived_at])?;
                                if let Some(mut before) = before.filter(|before| watch && changed > 0 && before.archived != archived_at.is_some()) {
                                    // The row of a session owing its sensitive rewrite is told without its content.
                                    if withheld::is_withheld_in(&tx, session)? {
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
                            Writer::withhold_on(&tx, &sessions)?;
                            acks.push(ack);
                        }
                        Command::Release { session, ack } => {
                            edges.extend(Writer::release_on(&tx, &session, watch)?);
                            acks.push(ack);
                        }
                        Command::Close => unreachable!("the writer stops before it queues a close"),
                        Command::Upsert { .. } | Command::Project { .. } | Command::Purge { .. } | Command::Reproject { .. } | Command::Reconcile { .. } => {
                            unreachable!("queued separately")
                        }
                    }
                }
                // Projections in arrival order, frame by frame. A projection is answered once its catalog row is written, so past
                // the transaction's first frame (not held back, so a frame larger than the room the rows leave still goes in) a
                // frame goes in only while the rows still fit after it: one per session with a row to write, and this projection's.
                let mut first = true;
                'outer: for pending in self.projections.iter_mut() {
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
                        pending.next += 1;
                    }
                    done_projections += 1;
                    // The frames are in: the row is built from this projection's own head (a
                    // newer explicit upsert of the session wins).
                    let latest = pending.projection.head.clone();
                    let seq = pending.seq;
                    let entry = self.upserts.entry(pending.projection.session.clone()).or_insert_with(|| (latest.clone(), DirtyMark::Keep, Vec::new(), seq));
                    if entry.3 < seq {
                        entry.0 = latest;
                        entry.3 = seq;
                    }
                }
                // Catalog rows, coalesced per session, after the frames so they see their state. A session's row waits while a
                // projection of it still queued is partly in (the row would count part of its frames) or came before the head the
                // row would take (that projection's own, older head would be written over it once it is in). A projection queued
                // after it does not hold it back: it writes the row again once it is in, so the row of a session whose
                // projections keep coming is not put off until they stop.
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
                    let (head, dirty, waiters, seq) = self.upserts.remove(&id).expect("listed");
                    rows += 1;
                    let (written, edge) = upsert_edge(&tx, &head, dirty, &self.labels, watch, archive.as_deref())?;
                    edges.extend(edge);
                    if written == 0 {
                        waiting.push((id.clone(), (head, seq)));
                    }
                    bytes += written;
                    acks.extend(waiters);
                }
                if let Some(sink) = self.sink.get().filter(|_| !edges.is_empty()) {
                    sink.writing(edges.len());
                    told = edges.len();
                }
                tx.commit()
            })();
        let result = result.map_err(|e| e.to_string());
        // The count told to the sink is given back before anything can leave this function: the assertion below panics in a
        // debug build, and a count never given back makes every later listing wait for ever.
        if result.is_err()
            && told > 0
            && let Some(sink) = self.sink.get()
        {
            sink.dropped(told);
        }
        debug_assert!(result.is_ok(), "append transaction failed: {result:?}");
        // Projections: finished ones leave the queue. On a failure the frames this transaction
        // applied are rolled back: the projections it reached (the front one at least, so a transaction that fails before
        // any frame still leaves fewer queued) are dropped with every later one of their sessions (applied past a dropped
        // one, it would leave a gap), to be reconciled from their cursor; the others stay queued, as the rows and requests
        // it did not reach do.
        let finished: Vec<Pending> = if result.is_ok() {
            self.projections.drain(..done_projections).collect()
        } else {
            let failed: std::collections::HashSet<String> =
                self.projections.iter().take(reached.max(done_projections).max(1)).map(|p| p.projection.session.clone()).collect();
            let (dropped, kept): (VecDeque<Pending>, VecDeque<Pending>) = self.projections.drain(..).partition(|p| failed.contains(&p.projection.session));
            self.projections = kept;
            dropped.into()
        };
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
        send(acks, &result);
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
            }
            tx.prepare_cached(
                "INSERT OR REPLACE INTO history (session, ordinal, iid, turn, form, model, visible, file_no,
                 frame_offset, frame_len, amend_ordinal, superseded_rev, facets)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, ?11)",
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
            for alias in aliases {
                tx.prepare_cached("INSERT OR IGNORE INTO history_alias (session, alias, ordinal) VALUES (?1, ?2, ?3)")?
                    .execute(params![session, alias, ordinal])?;
            }
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
                for alias in aliases {
                    tx.prepare_cached("INSERT OR IGNORE INTO history_alias (session, alias, ordinal) VALUES (?1, ?2, ?3)")?
                        .execute(params![session, alias, target])?;
                }
            }
        }
        FrameKind::Rewind { to_ordinal } => {
            let to = *to_ordinal as i64;
            // The smallest unit of progress is one version (three writes): a budget below
            // that is raised, so a tiny budget still advances.
            let mut left = budget.saturating_sub(1).max(3);
            used = 1;
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
            if left == 0 {
                return Ok((used, false));
            }
        }
        FrameKind::Compacted { cid, at, rows, mode, dropped, silent } => {
            // The divider sits at the compaction's own record (`archive_index::divider_place`).
            let boundary = ordinal;
            tx.prepare_cached(
                "INSERT OR REPLACE INTO compactions (session, ordinal, cid, file_no, frame_offset, frame_len,
                 boundary, at, drop_mode, silent, superseded_rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)",
            )?
            .execute(params![session, ordinal, cid, file_no, offset, len, boundary, at, *mode as i64, i64::from(*silent)])?;
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
        FrameKind::Run { rid, phase } => match phase {
            RunPhase::Started => {
                tx.prepare_cached(
                    "INSERT OR REPLACE INTO turns (session, rid, started_ordinal, end_ordinal, phase, superseded_rev)
                     VALUES (?1, ?2, ?3, NULL, 'started', NULL)",
                )?
                .execute(params![session, rid, ordinal])?;
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
    if let Some(op) = &frame.op {
        tx.prepare_cached(
            "INSERT INTO thread_ops (session, op_id, method, payload_digest, state, ordinal, file_no,
             frame_offset, frame_len) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(session, op_id) DO UPDATE SET state = excluded.state, ordinal = excluded.ordinal,
             file_no = excluded.file_no, frame_offset = excluded.frame_offset, frame_len = excluded.frame_len",
        )?
        .execute(params![session, op.id, op.method, op.digest, serde_name(&op.state), ordinal, file_no, offset, len])?;
    }
    // The first acceptance of a submission is its receipt: a later frame naming the id (the queued prompt's start, a requeue)
    // leaves it. A rewind or clear does not take it out: the send was accepted whatever the history shows now.
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
    Ok((used, true))
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

// ---------------------------------------------------------------------------------------
// Store handle and reads

struct Shared {
    path: PathBuf,
    /// The read pool and the writer channel, behind the boot reconcile.
    gate: gate::Gate,
    rows: RowSinkCell,
    /// The archive authority's snapshot, which the writer resolves each row through and the lead listing reads.
    archive: ArchiveCell,
    /// The sessions whose archive projection failed ([`SqliteStore::project_archive`]), each with the writer's read sequence when
    /// the failure was noted: owed until a projection that read its state after that commits. A reader of the projected
    /// `archived` column settles them first ([`SqliteStore::search`]), so it never reads a row the authority disagrees with.
    archive_owed: Mutex<HashMap<String, u64>>,
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

/// Where the next older page starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageCursor {
    pub history_rev: u64,
    pub level: usize,
    pub before: u64,
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
    pub fn open(lane: &InLane<MaintenanceIo>, thread: SqliteWriterThread, read_lane: InteractiveIo, data: &Path) -> Result<SqliteStore, DbError> {
        Self::open_reporting(lane, thread, read_lane, data, None)
    }

    /// [`Self::open`], reporting a rebuild's sessions done and total to `progress` as it runs.
    #[allow(clippy::disallowed_methods, reason = "runs on the maintenance lane job (lane proof argument)")]
    pub fn open_reporting(
        lane: &InLane<MaintenanceIo>,
        thread: SqliteWriterThread,
        read_lane: InteractiveIo,
        data: &Path,
        progress: Option<&RebuildProgress>,
    ) -> Result<SqliteStore, DbError> {
        // A log rewrite a stop cut short is settled first (`log_rewrite`'s step table); one past its swap gets its rows
        // rebuilt and its superseded blobs deleted below, before any session opens. No writer exists yet, so a store
        // of its own holds every pin there is (none).
        let blobs = crate::blobs::BlobStore::new(data);
        let rewritten = crate::log_rewrite::recover(lane, data, &crate::log::OsIo, &blobs).map_err(|e| DbError::Write(e.to_string()))?;
        let path = data.join(INDEX_FILE);
        let path = path.as_path();
        let existing = match path.exists().then(|| Writer::start(path)) {
            Some(Ok(writer)) => Some(writer),
            Some(Err(e)) if !needs_rebuild(&e) => return Err(e),
            _ => None,
        };
        let (incomplete, complete) = scan_session_dirs(lane, &data.join("sessions"), existing.is_none())?;
        let mut writer = match existing {
            Some(writer) => writer,
            None => {
                rebuild(lane, data, path, &complete, progress)?;
                Writer::start(path).map_err(|e| match e {
                    DbError::Rebuild(why) => DbError::Write(format!("rebuilt index refused: {why}")),
                    e => e,
                })?
            }
        };
        writer.boot_purge(lane, data, &incomplete)?;
        for session in rewritten {
            crate::log_rewrite::finish(lane, data, &session, &mut || {
                let rewrite = Rewritten { data: data.to_path_buf(), session: session.clone(), dirty: DirtyMark::Clear };
                writer.reproject(&rewrite)
            })
            .map_err(|e| DbError::Write(e.to_string()))?;
        }
        let dirty: Vec<String> =
            writer.conn.prepare_cached("SELECT id FROM sessions WHERE dirty = 1 ORDER BY id")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        let rows = writer.sink.clone();
        let archive = writer.archive.clone();
        let archive_reads = writer.archive_reads.clone();
        let (sender, rx) = mpsc::channel();
        let handle = thread.spawn_thread("mixdog-index-writer", move |_| writer.run(rx)).map_err(|e| DbError::Write(e.to_string()))?;
        let (gate, reconciler) = gate::Gate::new(ReadPool::new(path, read_lane), sender, !dirty.is_empty());
        let store = SqliteStore {
            shared: Arc::new(Shared {
                path: path.to_path_buf(),
                gate,
                rows,
                archive,
                archive_owed: Mutex::default(),
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
            }),
        };
        // The read lane's first job: every lane job that reads the index after this one waits for it, never the other way round.
        if let Some(reconciler) = reconciler {
            let data = data.to_path_buf();
            let _job = read_lane
                .submit(&CancellationToken::new(), move |lane| {
                    match reconcile(lane, &reconciler.pool, &reconciler.sender, &data, dirty) {
                        Ok(true) => reconciler.finish(Ok(())),
                        // The test seam: the process ended mid-reconcile; dropping the reconciler fails every access.
                        Ok(false) => {}
                        Err(why) => reconciler.finish(Err(why)),
                    }
                })
                .map_err(|_| DbError::LaneFull)?;
        }
        Ok(store)
    }

    /// Resolves once the sessions found dirty at open are reconciled (`reconcile`); every read
    /// and every acknowledged write waits for it, so none sees or changes a row the reconcile
    /// has yet to write. A reconcile that failed to write the index fails it.
    pub fn reconciled(&self) -> impl Future<Output = Result<(), DbError>> + Send + 'static {
        self.shared.gate.reconciled()
    }

    /// The number of reads and writes that waited for the reconcile so far.
    #[cfg(test)]
    pub(crate) fn reconcile_waiters(&self) -> watch::Receiver<usize> {
        self.shared.gate.waiters()
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
    }

    /// Connects the sink of the catalog row writes. Set once; the second call is refused.
    pub fn observe_rows(&self, sink: Arc<dyn RowSink>) -> Result<(), &'static str> {
        self.shared.rows.set(sink).map_err(|_| "the row sink is already set")
    }

    async fn ask(&self, make: impl FnOnce(Ack) -> Command) -> Result<(), DbError> {
        self.shared.gate.ask(make).await
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
                let noted = self.shared.archive_reads.load(std::sync::atomic::Ordering::SeqCst);
                for id in seen {
                    let debt = owed.entry(id).or_insert(noted);
                    *debt = (*debt).max(noted);
                }
            }
        }
        projected
    }

    /// Records `sessions` as owed a projection without waiting for the writer: [`search`](Self::search) and the next
    /// [`project_archive`](Self::project_archive) settle them.
    pub fn owe_archive(&self, sessions: Vec<String>) {
        let noted = self.shared.archive_reads.load(std::sync::atomic::Ordering::SeqCst);
        let mut owed = self.owed();
        for id in sessions {
            let debt = owed.entry(id).or_insert(noted);
            *debt = (*debt).max(noted);
        }
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
        self.ask(|ack| Command::Upsert { head: Arc::new(head), dirty, ack: Some(ack) }).await
    }

    /// RL §9.2 rule 1: committed before the activation's first append.
    pub async fn mark_dirty(&self, session: &str) -> Result<(), DbError> {
        let session = session.to_owned();
        self.ask(|ack| Command::MarkDirty { session, ack }).await
    }

    pub async fn set_status(&self, session: &str, status: SessionStatus, damage: Option<String>) -> Result<(), DbError> {
        let session = session.to_owned();
        self.ask(|ack| Command::Status { session, status, damage, ack }).await
    }

    pub async fn mark_deleted(&self, session: &str) -> Result<(), DbError> {
        let session = session.to_owned();
        self.ask(|ack| Command::Delete { session, ack }).await
    }

    /// The projection of a barrier; resolves when every frame is committed, and the session's catalog row with them (built from
    /// this head or a newer one; a fork whose inherited state is still being computed keeps its row until that is done).
    pub async fn project(&self, projection: Projection) -> Result<(), DbError> {
        self.ask(|ack| Command::Project { projection, ack: Some(ack) }).await
    }

    /// [`project`](Self::project) in two steps: resolves once the projection is queued at the writer, with the wait until every
    /// frame and the session's row are committed. The writer applies projections in the order they were queued, and a transaction
    /// takes every one queued when it starts, within its bounds.
    pub async fn queue_projection(&self, projection: Projection) -> Result<Committed, DbError> {
        let answer = self.shared.gate.queue(|ack| Command::Project { projection, ack: Some(ack) }).await?;
        Ok(Box::pin(gate::answered(answer)))
    }

    /// The rows of `session` (under `<data>/sessions`) rebuilt from its rewritten log, the replaced rows overwritten in
    /// the database and gone from the WAL; resolves once that is done.
    pub async fn reproject(&self, rewrite: Rewritten) -> Result<(), DbError> {
        #[cfg(feature = "test-support")]
        if self.shared.refuse_reproject.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return Err(DbError::Write("the test's injected rewrite projection failure".into()));
        }
        self.ask(|ack| Command::Reproject { rewrite, ack }).await
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

    fn read<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, DbError>> + Send + 'static {
        self.shared.gate.read(f)
    }

    /// RL §9.2 rule 5.
    pub async fn dirty_sessions(&self) -> Result<Vec<String>, DbError> {
        self.read(|c| {
            let mut stmt = c.prepare_cached("SELECT id FROM sessions WHERE dirty = 1")?;
            let rows = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .await
    }

    /// The next frame to project.
    pub async fn projected(&self, session: &str) -> Result<Option<FramePos>, DbError> {
        let session = session.to_owned();
        self.read(move |c| projected_on(c, &session)).await
    }

    /// Whether the projection has reached this exact durable log end, including its identity.
    pub fn history_projected_through_on_lane(&self, _lane: &InLane<InteractiveIo>, session: &str, log_id: &str, end: FramePos) -> Result<bool, DbError> {
        self.shared.gate.with(|c| {
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
        self.shared.gate.with(|c| {
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
        let (session, op_id) = (session.to_owned(), op_id.to_owned());
        self.read(move |c| thread_op_on(c, &session, &op_id)).await
    }

    /// The receipt of submission `submission` of `session` as projected so far ([`Self::submission_on_lane`]).
    pub async fn submission(&self, session: &str, submission: &str) -> Result<Option<serde_json::Value>, DbError> {
        let (session, submission) = (session.to_owned(), submission.to_owned());
        self.read(move |c| submission_on(c, &session, &submission)).await
    }

    /// `thread_op` inside a job already on the read lane: answered on the job's thread, so the job never waits for a lane slot
    /// behind itself.
    pub fn thread_op_on_lane(&self, _lane: &InLane<InteractiveIo>, session: &str, op_id: &str) -> Result<Option<ThreadOp>, DbError> {
        self.shared.gate.with(|c| thread_op_on(c, session, op_id))
    }

    /// The answer the first acceptance of submission `submission` of `session` got (`submissions`), on the read lane.
    pub fn submission_on_lane(&self, _lane: &InLane<InteractiveIo>, session: &str, submission: &str) -> Result<Option<serde_json::Value>, DbError> {
        self.shared.gate.with(|c| submission_on(c, session, submission))
    }

    /// The ops of `session` that `op/status{fence}` fenced (P §9.4): an actor refuses them at
    /// load, so a fence survives a reload.
    pub async fn fenced_ops(&self, session: &str) -> Result<Vec<String>, DbError> {
        let session = session.to_owned();
        self.read(move |c| fenced_ops_on(c, &session)).await
    }

    /// `fenced_ops` inside a job already on the read lane.
    pub fn fenced_ops_on_lane(&self, _lane: &InLane<InteractiveIo>, session: &str) -> Result<Vec<String>, DbError> {
        self.shared.gate.with(|c| fenced_ops_on(c, session))
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
        self.read(move |c| dividers_on(c, &lineage, cut, level, from, to)).await
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
        self.shared.gate.with(|c| dividers_on(c, lineage, cut, level, from, to))
    }

    /// The JSON list row of a session; `None` for a session whose log has no readable
    /// `session` frame (1.4.5 reads such a file as no session) or that was deleted.
    pub async fn summary(&self, session: &str) -> Result<Option<String>, DbError> {
        let session = session.to_owned();
        let found: Option<(String, bool)> = self
            .read(move |c| {
                Ok(c.prepare_cached(&format!("SELECT summary, {WITHHELD_COL} FROM sessions WHERE id = ?1 AND log_id <> '' AND deleted = 0"))?
                    .query_row([&session], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()?)
            })
            .await?;
        Ok(found.map(|(summary, withheld)| if withheld { withheld::blank_summary(&summary) } else { summary }))
    }

    /// The header members a listing reads of a session (`worker::LISTED_FIELDS`), from its catalog row. The outer `None`:
    /// the index cannot answer for the session (no row, a row behind its log, or a deleted one) and its record is the
    /// source; the inner `None`: a session kept only to host a worker row.
    pub async fn listed(&self, session: &str) -> Result<Option<Option<String>>, DbError> {
        let sessions = vec![session.to_owned()];
        Ok(self.read(move |c| listed_on(c, &sessions)).await?.pop().flatten())
    }

    /// [`listed`](Self::listed) of every session of a listing, in order and in one read, on the calling thread (a job of
    /// the read lane): a listing names hundreds of sessions, and a read each filled the lane's queue. The caller queues
    /// the one job, so a full queue is waited out there and never answered as "the index cannot say".
    pub fn listed_many(&self, _lane: &InLane<InteractiveIo>, sessions: &[String]) -> Result<Vec<Option<Option<String>>>, DbError> {
        self.shared.gate.with(|c| listed_on(c, sessions))
    }

    /// What the index knows of the sessions that may name the sidecars of session `own` (no session log is opened):
    /// the sessions whose reference set names it, in id order, a deleted one and `own` left out; the first session it
    /// holds as not readable (`status` other than `ok`); a copy whose set names it that the process of boot `boot` is
    /// still making; and every other listed session whose set is unknown (its header holds none and no scan of its
    /// transcript is current), with the ordinal it is projected to.
    pub async fn offload_referencers(&self, own: &str, boot: &str) -> Result<OffloadReferencers, DbError> {
        let (own, boot) = (own.to_owned(), boot.to_owned());
        let segment = crate::offload_sources::segment_key(&crate::offload_sources::safe_segment(&own));
        self.read(move |c| {
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
                   AND (k.session IS NULL OR k.rules <> ?2 OR (k.ordinal IS NOT NULL AND k.ordinal <> s.projected_ordinal))
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
        let session = session.to_owned();
        self.ask(|ack| Command::OffloadScan { session, ordinal, sources, ack }).await
    }

    /// The raw header `title` of a session (1.4.5 `readStoredSessionMetadata`'s
    /// `session.title || null`); `None` when it has none, is not listed or was deleted.
    pub async fn title(&self, session: &str) -> Result<Option<String>, DbError> {
        let session = session.to_owned();
        self.read(move |c| {
            Ok(c.prepare_cached(
                "SELECT title FROM sessions WHERE id = ?1 AND log_id <> '' AND deleted = 0
                 AND NOT EXISTS (SELECT 1 FROM withheld_sessions w WHERE w.id = sessions.id)",
            )?
            .query_row([&session], |r| r.get(0))
            .optional()?
            .flatten())
        })
        .await
    }

    /// The sessions not deleted whose header carries `child`'s archived result (`archived_agents`).
    pub async fn archived_agent_parents(&self, child: &str) -> Result<Vec<String>, DbError> {
        let child = child.to_owned();
        self.read(move |c| {
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
        let session = session.to_owned();
        self.read(move |c| Ok(c.prepare_cached("SELECT deleted FROM sessions WHERE id = ?1")?.query_row([&session], |r| r.get(0)).optional()?)).await
    }

    /// Every session the index holds as deleted, in one read ([`deleted`](Self::deleted) for all of them).
    pub async fn deleted_ids(&self) -> Result<std::collections::HashSet<String>, DbError> {
        self.read(move |c| {
            let mut stmt = c.prepare_cached("SELECT id FROM sessions WHERE deleted = 1")?;
            Ok(stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)
        })
        .await
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
        loop {
            // A session owing its sensitive rewrite is not removed while its rewrite may be moving its folder
            // (`PURGEABLE_ALL_SQL` leaves it out): a later purge (the next delete's, or the next start's) removes it once
            // it is released.
            let found = self.read(move |c| Ok(c.prepare_cached(PURGEABLE_ALL_SQL)?.query_row([], |r| r.get::<_, String>(0)).optional()?));
            let Some(session) = found.await? else { return Ok(purged) };
            let dir = data.join("sessions").join(&session);
            lane.submit(&CancellationToken::new(), move |lane| remove_session_dir(lane, &dir))
                .map_err(|_| DbError::LaneFull)?
                .await
                .map_err(|_| DbError::Stopped)??;
            let id = session.clone();
            self.ask(|ack| Command::Purge { session: id, ack }).await?;
            purged.push(session);
        }
    }

    /// The worker rows (FORMAT.md §8.2 worker index) in `scope`, of tag `tag` when given
    /// (a cleaned tag; '' finds the rows without one), newest session first.
    pub async fn worker_rows(&self, tag: Option<&str>, scope: WorkerScope) -> Result<Vec<WorkerRow>, DbError> {
        let tag = tag.map(str::to_owned);
        self.read(move |c| {
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
        use crate::worker::IndexedSession;
        #[cfg(test)]
        let hold = self.shared.worker_read_hold.lock().expect("hold").take();
        self.read(move |c| {
            let tx = c.unchecked_transaction()?;
            let (revision, floor, generation) =
                tx.query_row(crate::worker::REVISION_SQL, [], |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64)))?;
            let row = |r: &rusqlite::Row<'_>| -> rusqlite::Result<IndexedSession> {
                let worker = match r.get::<_, Option<String>>(2)? {
                    Some(text) => {
                        Some(serde_json::from_str(&text).map_err(|e| rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e)))?)
                    }
                    None => None,
                };
                let summary: Option<String> = r.get(4)?;
                let mut agent = match summary {
                    Some(summary) => Some((r.get(3)?, summary)),
                    None => None,
                };
                let mut worker: Option<serde_json::Map<String, serde_json::Value>> = worker;
                if r.get::<_, bool>(5)? {
                    if let Some(worker) = worker.as_mut() {
                        withheld::keep_structural(worker);
                    }
                    if let Some((_, summary)) = agent.as_mut() {
                        *summary = withheld::blank_summary(summary);
                    }
                }
                Ok(IndexedSession { session: r.get(0)?, created_at: r.get(1)?, worker, agent })
            };
            let full = since.is_none_or(|(held, rev)| held != generation || rev > revision || rev < floor);
            let mut sessions: Vec<IndexedSession> = Vec::new();
            if full {
                let mut stmt = tx.prepare_cached(crate::worker::INDEXED_ALL_SQL)?;
                sessions = stmt.query_map([], row)?.collect::<Result<_, _>>()?;
            } else {
                let since = since.map_or(0, |(_, rev)| rev) as i64;
                let mut at: HashMap<String, usize> = HashMap::new();
                let mut put = |sessions: &mut Vec<IndexedSession>, s: IndexedSession| match at.get(&s.session) {
                    Some(&i) => sessions[i] = s,
                    None => {
                        at.insert(s.session.clone(), sessions.len());
                        sessions.push(s);
                    }
                };
                let gone = |id: String| IndexedSession { session: id, created_at: None, worker: None, agent: None };
                let removed: Vec<String> = tx.prepare_cached(crate::worker::REMOVED_SINCE_SQL)?.query_map([since], |r| r.get(0))?.collect::<Result<_, _>>()?;
                for id in removed {
                    put(&mut sessions, gone(id));
                }
                let changed: Vec<IndexedSession> = tx.prepare_cached(crate::worker::INDEXED_SINCE_SQL)?.query_map([since], row)?.collect::<Result<_, _>>()?;
                for s in changed {
                    put(&mut sessions, s);
                }
                for id in also {
                    if sessions.iter().any(|s| s.session == id) {
                        continue;
                    }
                    let found = tx.prepare_cached(crate::worker::INDEXED_ONE_SQL)?.query_row([&id], row).optional()?;
                    put(&mut sessions, found.unwrap_or_else(|| gone(id)));
                }
            }
            #[cfg(test)]
            if let Some(hold) = hold {
                hold();
            }
            tx.commit()?;
            Ok(crate::worker::WorkerIndexRead { revision, generation, full, sessions })
        })
        .await
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
        self.read(move |c| {
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
        self.read(|c| {
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
        self.read(move |c| {
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
        self.read(move |c| page_on(c, &lineage, cut, cursor, limit)).await
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
        let (rows, next) = self.shared.gate.with(|c| crate::context::rows_on(c, lineage, cut, cursor, limit))?;
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
                match self.shared.gate.with(|c| crate::context::rows_on(c, lineage, cut, cursor, PAGE_ROWS)) {
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
                match self.shared.gate.with(|c| crate::context::rows_on(c, lineage, cut, cursor, PAGE_ROWS)) {
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
        self.shared.gate.with(|c| page_on(c, lineage, cut, cursor, limit))
    }

    /// `anchor_on`, as a job of the read pool.
    pub async fn history_anchor(
        &self,
        lineage: Vec<LineageLevel>,
        cut: Option<u64>,
        ids: Vec<String>,
        alias: String,
    ) -> Result<Option<HistoryAnchor>, DbError> {
        self.read(move |c| anchor_on(c, &lineage, cut, &ids, &alias)).await
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
        self.shared.gate.with(|c| anchor_on(c, lineage, cut, ids, alias))
    }

    /// The live `compacted` frame whose replacement holds the entry `iid` (such as the
    /// summary, which has no history row), as the reader of `lineage` with `cut` sees it:
    /// its `ordinal` is that of a `model_switch` anchor on the entry (FORMAT.md §5.3). The
    /// newest such frame when later replacements kept the entry; `None` when no live one
    /// holds it.
    pub async fn compaction_entry(&self, lineage: Vec<LineageLevel>, cut: Option<u64>, iid: String) -> Result<Option<CompactionEntry>, DbError> {
        self.read(move |c| compaction_entry_on(c, &lineage, cut, &iid)).await
    }

    /// `compaction_entry` inside a job already on the read lane.
    pub fn compaction_entry_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        iid: &str,
    ) -> Result<Option<CompactionEntry>, DbError> {
        self.shared.gate.with(|c| compaction_entry_on(c, lineage, cut, iid))
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
    for (head, damage) in heads {
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

/// Projects the logs of `sessions` into `conn`, and answers each one's row and damage. The logs are read, folded and
/// projected on every core at once, and written by this thread alone in the order of `sessions`, one session whole
/// before the next: the database is the one a single reader makes. Read one after another, the logs of a thousand
/// sessions held a start for over a minute. The readers are threads of this call, not lane jobs: the caller's job holds
/// its lane for the whole projection and waits for them here, and they end before it returns.
#[allow(clippy::disallowed_methods, reason = "blocking by contract: the caller is a maintenance lane job or the migration's own thread")]
fn project_sessions(
    conn: &mut Connection,
    data: &Path,
    sessions: &[String],
    progress: Option<&RebuildProgress>,
) -> Result<Vec<(CatalogHead, Option<String>)>, String> {
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
                        heads.push((head, damage));
                        break;
                    }
                }
                .map_err(|e| format!("{id}: {e}"))?;
            }
        }
        Ok(heads)
    })
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

/// The reconcile's way into the open index: each message is applied by the writer thread,
/// and the lane job waits for it (one read chunk of frames in memory at a time).
struct ToWriter<'a>(&'a mpsc::Sender<Command>);

impl ToWriter<'_> {
    fn send(&self, session: &str, frames: Vec<ProjectedFrame>, finish: Option<(CatalogHead, Option<String>)>) -> Result<(), String> {
        let (ack, done) = mpsc::channel();
        let stopped = |_| "the index writer stopped".to_owned();
        self.0
            .send(Command::Reconcile { session: session.to_owned(), frames, finish: finish.map(Box::new), ack })
            .map_err(|_| "the index writer stopped".to_owned())?;
        done.recv().map_err(stopped)?.map_err(|e| e.to_string())
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
        self.send(session, frames, None)
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
        ToWriter(self.sender).send(session, frames, None)
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

    /// The sessions still listed by a pending row that have no log under `<data>/sessions`: listed, and not there.
    #[allow(clippy::disallowed_methods, reason = "runs on the read lane job (lane proof argument)")]
    pub async fn pending_sessions(&self, data: &Path) -> Result<Vec<String>, DbError> {
        let sessions = data.join("sessions");
        self.shared
            .gate
            .read_in_lane(move |_, c| {
                let mut stmt = c.prepare_cached("SELECT id FROM sessions WHERE log_id = ?1 AND deleted = 0")?;
                let listed: Vec<String> = stmt.query_map([PENDING_LOG_ID], |r| r.get(0))?.collect::<Result<_, _>>()?;
                Ok(listed.into_iter().filter(|id| !sessions.join(id).join(crate::log::log_name(0)).is_file()).collect())
            })
            .await
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
            self.shared.gate.with(|c| Ok(c.prepare_cached("SELECT log_id FROM sessions WHERE id = ?1")?.query_row([session], |r| r.get(0)).optional()?))?;
        // A pending row holds no frame: the row takes the log's identity at its first frame, dirty from there on, so a process
        // that ends after it leaves a session the boot reconcile finishes (and this, on the next run, leaves alone).
        let pending = match held.as_deref() {
            None => false,
            Some(PENDING_LOG_ID) => true,
            Some(_) => return Ok(()),
        };
        let mut to = Adopting { sender: self.shared.gate.feed()?, pending };
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

/// RL §9.2 rule 5, a job on the read lane that `SqliteStore::open` starts once the writer
/// runs: a session still marked dirty was active when the process last ended, and the frames
/// its log acked after the index's projected cursor were never projected (the projection runs
/// behind the ack, so a process that ends right after an ack loses it). Those frames are
/// projected now and its catalog row is written from its log, so a read after a crash sees
/// every acked row (a prompt whose turn the crash interrupted included). A cursor at the log's
/// end does not show the row is current (the row is written after the projection, by the live
/// writer and here alike), so every dirty session is folded; its mark is cleared in the row's
/// own transaction, and a process that ends between the projection and the row reconciles the
/// session again. `Ok(false)`: the test seam ended it, as a process ending there.
#[allow(clippy::disallowed_methods, reason = "runs on the read lane job (lane proof argument)")]
fn reconcile(_lane: &InLane<InteractiveIo>, pool: &ReadPool, sender: &mpsc::Sender<Command>, data: &Path, dirty: Vec<String>) -> Result<bool, String> {
    #[cfg(test)]
    reconcile_seam::wait_if_held(data);
    let blobs = crate::blobs::BlobStore::new(data);
    for session in dirty {
        let dir = data.join("sessions").join(&session);
        if !dir.is_dir() {
            continue;
        }
        #[cfg(test)]
        if reconcile_seam::fails_here(data) {
            return Err(format!("{session}: the test seam failed the index write"));
        }
        let from = pool.with(|c| projected_on(c, &session)).map_err(|e| format!("{session}: {e}"))?;
        let mut fold = None;
        let mut to = ToWriter(sender);
        let damage = project_session(&mut to, &dir, &blobs, &mut fold, from)
            .map_err(|e| format!("{session}: {e}"))?
            .err()
            .map(|(error, at)| damage_text(&dir, at, &error));
        #[cfg(test)]
        if reconcile_seam::ends_here(data) {
            return Ok(false);
        }
        let head = fold.as_ref().map_or_else(|| unreadable_head(&session), CatalogHead::of);
        to.send(&session, Vec::new(), Some((head, damage))).map_err(|e| format!("{session}: {e}"))?;
    }
    Ok(true)
}

/// Projects the log in `dir` forward into `to`, folding into `fold`. The outer error is
/// an index write failure; the inner one is the log's own failure, after which the frames
/// before it stay projected. `from`: the index already holds every frame before this one
/// (the reconcile), so those are folded only.
/// A record whose body is a session's header or state (the `session` header, a checkpoint's state, a header change): it
/// holds no rows, so a loss of it is no row loss; the fold accounts for it ([`crate::fold::fold_salvaging`]) and clears it
/// when a later checkpoint restores what it made.
fn fold_owned(record: &crate::schema::record::Record) -> bool {
    use crate::schema::record::Record;
    matches!(record, Record::Session(_) | Record::Checkpoint(_) | Record::Meta(_))
}

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
    let mut pos = FramePos { ordinal: first, file_no: 0, offset: 0 };
    // A body whose blob is missing or corrupt stops nothing (FORMAT.md §4.5): its record is folded and projected as far
    // as it can be, every later frame is projected with its references, and the losses become the session's damage.
    let gone = std::cell::RefCell::new(Vec::new());
    let mut resolve = crate::fold::noting(blobs, &gone);
    let mut losses = crate::fold::Losses::default();
    // A reconcile needs the frames from `from` on and the fold at the end: it starts at the newest anchor before `from`
    // (a checkpoint every MiB, or the session frame), as an open does, instead of folding the whole log from its first
    // frame. After an unclean exit every session that was active is reconciled at the next start, and the index's reads
    // wait for it: folded from the start, a hundred long logs held the start for a minute.
    if let Some(from) = from
        && fold.is_none()
        && let Some((anchor, anchored, next)) = crate::log::newest_anchor_fold_unlaned(dir, &mut resolve)
        && anchor.ordinal < from.ordinal
    {
        *fold = Some(anchored);
        pos = next;
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
        for (record, at, frame_len) in &read.frames {
            let folded = crate::fold::fold_salvaging(fold, record, *at, &mut resolve, &gone, &mut losses);
            let started = match folded {
                Ok(started) => started,
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
            // A record whose body is lost keeps its references and op, and no rows of its own.
            let (kind, op) = match crate::projection::project(record, &mut resolve) {
                Ok(projected) => projected,
                Err(e) => match crate::fold::take_lost(&gone) {
                    Some(digests) => {
                        if !fold_owned(record) {
                            losses.row(at.ordinal, digests);
                        }
                        (crate::projection::FrameKind::Other, crate::projection::record_op(record))
                    }
                    None => {
                        failure = Some(log(e));
                        break;
                    }
                },
            };
            let receipt = match crate::projection::receipt(record, &mut resolve) {
                Ok(receipt) => receipt,
                Err(e) => match crate::fold::take_lost(&gone) {
                    Some(digests) => {
                        if !fold_owned(record) {
                            losses.row(at.ordinal, digests);
                        }
                        None
                    }
                    None => {
                        failure = Some(log(e));
                        break;
                    }
                },
            };
            for blob in crate::projection::unread_bodies(record) {
                if let Err(e) = resolve(blob) {
                    match crate::fold::take_lost(&gone) {
                        Some(digests) => losses.row(at.ordinal, digests),
                        // Not a loss (an I/O error that may pass): the read ends here, as it does for a row body.
                        None => {
                            failure = Some(log(e));
                            break;
                        }
                    }
                }
            }
            if failure.is_some() {
                break;
            }
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

/// `frames` in transactions of at most `APPEND_ROWS` rows.
fn apply_all(conn: &mut Connection, session: &str, frames: &[ProjectedFrame]) -> rusqlite::Result<()> {
    let mut i = 0;
    while i < frames.len() {
        let tx = conn.transaction()?;
        let mut rows = 0;
        while i < frames.len() && rows < APPEND_ROWS {
            let (used, complete) = apply_frame(&tx, session, &frames[i], APPEND_ROWS - rows, APPEND_ROWS)?;
            rows += used;
            if !complete {
                break;
            }
            i += 1;
        }
        tx.commit()?;
    }
    Ok(())
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

fn dividers_on(c: &Connection, lineage: &[LineageLevel], cut: Option<u64>, level: usize, from: u64, to: u64) -> Result<Vec<Divider>, DbError> {
    let clamp = |v: u64| v.min(i64::MAX as u64) as i64;
    let mut out = Vec::new();
    for (i, home) in lineage.iter().enumerate() {
        let asof = home.end.map_or(i64::MAX, clamp);
        let mut stmt = c.prepare_cached(
            "SELECT ordinal, file_no, frame_offset, frame_len, cid, boundary, at FROM compactions
             WHERE session = ?1 AND ordinal < ?3 AND silent = 0 AND (superseded_rev IS NULL OR superseded_rev >= ?2)",
        )?;
        let found = stmt
            .query_map(params![home.session, asof, crate::archive_index::level_bound(lineage, cut, i)], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    (r.get::<_, u32>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?),
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (ordinal, (file_no, offset, len), cid, own_boundary, at) in found {
            let _ = own_boundary; // an index written before the divider moved to its own record holds the old place
            let place = crate::archive_index::divider_place(i, ordinal as u64);
            if place.0 == level && place.1 >= from && place.1 < to {
                // The records anchored here: the compaction's own log and each later
                // level's up to its fork point, keyed (entry position, level, record).
                let mut found = Vec::new();
                for (rank, holder) in lineage[..=i].iter().rev().enumerate() {
                    let end = holder.end.map_or(i64::MAX, clamp);
                    let mut stmt = c.prepare_cached(ENTRY_SWITCHES_SQL)?;
                    let rows = stmt.query_map(params![holder.session, ordinal, home.session, end], |s| {
                        Ok(((s.get::<_, i64>(0)?, rank, s.get::<_, i64>(1)?), ModelSwitchEntry { provider: s.get(2)?, model_id: s.get(3)?, at: s.get(4)? }))
                    })?;
                    for row in rows {
                        found.push(row?);
                    }
                }
                found.sort_by_key(|(key, _)| *key);
                out.push(Divider {
                    session: home.session.clone(),
                    cid,
                    pos: FramePos { ordinal: ordinal as u64, file_no, offset: offset as u64 },
                    frame_len: len as u64,
                    level: place.0,
                    boundary: place.1,
                    at,
                    model_switches: found.into_iter().map(|(_, entry)| entry).collect(),
                });
            }
        }
    }
    out.sort_by_key(|d| (d.boundary, d.pos.ordinal));
    Ok(out)
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
    let by_iid = format!(
        "SELECT min(h.ordinal), count(*) FROM history h WHERE h.session = ?1 AND h.iid IN ({marks}) AND h.ordinal < ?2 AND h.visible = 1
         AND (h.superseded_rev IS NULL OR h.superseded_rev >= ?3)"
    );
    let by_alias = "SELECT min(h.ordinal), count(*) FROM history_alias a JOIN history h ON h.session = a.session AND h.ordinal = a.ordinal
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
fn page_on(c: &Connection, lineage: &[LineageLevel], cut: Option<u64>, cursor: Option<PageCursor>, limit: usize) -> Result<Page, DbError> {
    {
        {
            let rev: i64 =
                c.prepare_cached("SELECT history_rev FROM sessions WHERE id = ?1")?.query_row([&lineage[0].session], |r| r.get(0)).optional()?.unwrap_or(0);
            let rev = rev as u64;
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
                let mut stmt = c.prepare_cached(PAGE_SQL)?;
                let want = (limit - out.len()) as i64;
                let mut rows = stmt.query(params![level.session, before.min(i64::MAX as u64) as i64, floor, want])?;
                let mut got = 0;
                let mut full = false;
                while let Some(r) = rows.next()? {
                    got += 1;
                    #[cfg(any(test, feature = "test-support"))]
                    crate::read_count::add(&lineage[0].session, 1);
                    let frame_len = r.get::<_, i64>(7)? as u64;
                    let amend = match r.get::<_, Option<i64>>(8)? {
                        Some(o) => Some((FramePos { ordinal: o as u64, file_no: r.get(9)?, offset: r.get::<_, i64>(10)? as u64 }, r.get::<_, i64>(11)? as u64)),
                        None => None,
                    };
                    let cost = frame_len + amend.map_or(0, |(_, l)| l);
                    if !out.is_empty() && bytes + cost > PAGE_MAX_BYTES {
                        full = true;
                        break;
                    }
                    bytes += cost;
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
                        verdict = compactions.verdict(cur.level, ordinal, &iid, &facets)?;
                    }
                    let mut kept = Vec::new();
                    if model && form == Form::Message {
                        let mut copies = c.prepare_cached(KEPT_SQL)?;
                        let found = copies.query_map(params![level.session, iid, ordinal as i64, floor], |k| {
                            Ok(KeptCopy {
                                compaction: FramePos { ordinal: k.get::<_, i64>(0)? as u64, file_no: k.get(1)?, offset: k.get::<_, i64>(2)? as u64 },
                                frame_len: k.get::<_, i64>(3)? as u64,
                                idx: k.get(4)?,
                            })
                        })?;
                        for copy in found {
                            kept.push(copy?);
                        }
                    }
                    // The anchor's boundaries come from its own log or a later level's: a
                    // base level's records up to its fork point, oldest level first.
                    let mut model_switches = Vec::new();
                    for holder in lineage[..=cur.level].iter().rev() {
                        let end = holder.end.map_or(i64::MAX, |e| e as i64);
                        let mut stmt = c.prepare_cached(MODEL_SWITCHES_SQL)?;
                        let found = stmt.query_map(params![holder.session, ordinal as i64, iid, end], |s| {
                            Ok(ModelSwitchEntry { provider: s.get(0)?, model_id: s.get(1)?, at: s.get(2)? })
                        })?;
                        for entry in found {
                            model_switches.push(entry?);
                        }
                    }
                    out.push(HistoryRow {
                        session: level.session.clone(),
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
                    });
                    cur.before = ordinal;
                }
                if full {
                    break;
                }
                if (got as i64) < want {
                    cur.level += 1;
                    cur.before = u64::MAX;
                }
            }
            let next = (cur.level < lineage.len()).then_some(cur);
            Ok((out, next))
        }
    }
}

/// The live replacement copies (oldest compaction first) of message `?2` written after its
/// row at `?3`, as of `?4` (the fork point, else `i64::MAX`).
pub(crate) const KEPT_SQL: &str = "SELECT c.ordinal, c.file_no, c.frame_offset, c.frame_len, m.idx FROM message_rows m
     JOIN compactions c ON c.session = m.session AND c.ordinal = m.ordinal
     WHERE m.session = ?1 AND m.iid = ?2 AND m.ordinal > ?3 AND m.ordinal < ?4 AND m.ver = m.ordinal
       AND (m.superseded_rev IS NULL OR m.superseded_rev >= ?4)
       AND (c.superseded_rev IS NULL OR c.superseded_rev >= ?4) ORDER BY m.ordinal";

/// The model-switch boundaries in session `?1`'s log below `?4` anchored on row `?2` with
/// iid `?3`, in record order.
pub(crate) const MODEL_SWITCHES_SQL: &str = "SELECT provider, model_id, at FROM model_switches
     WHERE session = ?1 AND anchor_ordinal = ?2 AND anchor_iid = ?3 AND ordinal < ?4 ORDER BY ordinal";

/// The model-switch boundaries in session `?1`'s log below `?4` anchored on a replacement
/// entry of session `?3`'s `compacted` frame at `?2`, with the entry's position.
pub(crate) const ENTRY_SWITCHES_SQL: &str = "SELECT min(m.idx), s.ordinal, s.provider, s.model_id, s.at
     FROM model_switches s JOIN message_rows m ON m.session = ?3 AND m.ordinal = s.anchor_ordinal
       AND m.iid = s.anchor_iid
     WHERE s.session = ?1 AND s.anchor_ordinal = ?2 AND s.ordinal < ?4 GROUP BY s.ordinal";

/// One history page level: visible rows below `?2`, live for the reader at `?3`.
pub(crate) const PAGE_SQL: &str = "SELECT h.ordinal, h.iid, h.turn, h.form, h.model, h.file_no, h.frame_offset, h.frame_len,
       a.ordinal, a.file_no, a.frame_offset, a.frame_len,
       h.facets
     FROM history h LEFT JOIN amends a ON a.session = h.session AND a.ordinal = h.amend_ordinal
     WHERE h.session = ?1 AND h.ordinal < ?2 AND h.visible = 1
       AND (h.superseded_rev IS NULL OR h.superseded_rev >= ?3)
     ORDER BY h.ordinal DESC LIMIT ?4";

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

/// `(sql, ?1, limit)` of a session search (FORMAT.md §8.2); `?3..?5` are the keyset. Its rows are `(summary, withheld)`, the
/// withheld state read in the statement that reads the row: a query never matches a session owing its sensitive rewrite
/// (what matched may be the value marked) and leaves it out before its limit; the recent list (no query) answers it, to be
/// shown without its content.
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

/// Read connections of one database. `run` executes a read as a job on the read lane,
/// so no caller blocks a runtime thread; `with` runs it on the calling thread, for code
/// already inside a lane job (the fold's lookups on the durability lane, GC on the
/// maintenance lane).
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
        let job = self.lane.submit(&CancellationToken::new(), move |lane| pool.with(|c| f(lane, c))).map_err(|_| DbError::LaneFull);
        async move { job?.await.map_err(|_| DbError::Stopped)? }
    }
}

impl LineageIndex for SqliteStore {
    fn live_rows(&self, session: &str, from: u64, to: u64) -> Result<(u64, u64), LookupError> {
        self.shared.gate.with(|c| {
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
        self.shared.gate.with(|c| {
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
