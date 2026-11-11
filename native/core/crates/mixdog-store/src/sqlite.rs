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
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;

mod gate;
pub mod lead;
#[cfg(test)]
mod model_tests;
#[cfg(test)]
mod purge_tests;
pub mod listing;

use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::MaintenanceIo;
use mixdog_rt::LaneToken;
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
use crate::schema::bounded::Digest;
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
    #[error("read lane full")]
    LaneFull,
    /// The history changed (a rewind) since the cursor was issued.
    #[error("history cursor is stale")]
    CursorStale,
}

pub(crate) fn open_connection(path: &Path) -> Result<Connection, DbError> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "wal_autocheckpoint", 0)?;
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    conn.busy_timeout(std::time::Duration::ZERO)?;
    Ok(conn)
}

/// Opens the writer connection, running the DDL on an empty file and checking the ids.
pub(crate) fn open_schema(path: &Path, ddl: &str, app_id: i32, user_version: i32) -> Result<Connection, DbError> {
    let mut conn = open_connection(path)?;
    let tables: i64 = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))?;
    if tables == 0 {
        conn.execute_batch(ddl)?;
    }
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
fn open_writer(path: &Path) -> Result<Connection, DbError> {
    let conn = open_schema(path, INDEX_DDL, INDEX_APPLICATION_ID, INDEX_USER_VERSION)?;
    conn.pragma_update(None, "secure_delete", "ON").map_err(|e| DbError::Write(e.to_string()))?;
    Ok(conn)
}

/// The index database of a data dir.
pub const INDEX_FILE: &str = "index/store.sqlite";

/// Whether an open of the index failed because of the file itself: another identity, or
/// bytes SQLite cannot read as a database.
fn needs_rebuild(e: &DbError) -> bool {
    match e {
        DbError::Rebuild(_) => true,
        DbError::Sqlite(e) => matches!(
            e.sqlite_error_code(),
            Some(rusqlite::ErrorCode::NotADatabase | rusqlite::ErrorCode::DatabaseCorrupt)
        ),
        _ => false,
    }
}

/// Projects every session of `data` into a staged database and publishes it over `path`.
/// The old file's WAL and shared memory go first, so they never pair with the new file; a
/// crash before the publish leaves a file that still fails its open and rebuilds again.
#[allow(clippy::disallowed_methods, reason = "runs on the maintenance lane job (lane proof argument)")]
fn rebuild(_lane: &InLane<MaintenanceIo>, data: &Path, path: &Path) -> Result<(), DbError> {
    let failed = |e: String| DbError::Write(format!("index rebuild: {e}"));
    let dir = path.parent().expect("index file in a directory");
    crate::fsio::create_dir_durable(dir).map_err(|e| failed(e.to_string()))?;
    crate::fsio::sweep_tmp_unlaned(dir).map_err(|e| failed(e.to_string()))?;
    let staged = crate::fsio::tmp_path(path);
    project_index(data, &staged, &session_ids(&data.join("sessions")).map_err(failed)?).map_err(failed)?;
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

/// Every session directory holding its first log file, in name order.
#[allow(clippy::disallowed_methods, reason = "called from the rebuild's maintenance lane job")]
fn session_ids(sessions: &Path) -> Result<Vec<String>, String> {
    let entries = match std::fs::read_dir(sessions) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}: {e}", sessions.display())),
    };
    let mut ids = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("{}: {e}", sessions.display()))?;
        let Ok(name) = entry.file_name().into_string() else { continue };
        if entry.path().join(crate::log::log_name(0)).is_file() {
            ids.push(name);
        }
    }
    ids.sort();
    Ok(ids)
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
    tx.prepare_cached("UPDATE sessions SET status = ?2, damage = ?3 WHERE id = ?1")?
        .execute(params![session, status.as_str(), damage])?;
    Ok(())
}

/// A deleted session no other session forks from (a purged fork takes its edge with it).
const PURGEABLE_SQL: &str = "SELECT id FROM sessions s WHERE deleted = 1
    AND NOT EXISTS (SELECT 1 FROM fork_edges e WHERE e.base = s.id) LIMIT 1";

/// The tables holding a session's rows, with their keys: a purge step deletes by key.
const PURGE_TABLES: [(&str, &str); 14] = [
    ("history", "session, ordinal"),
    ("model_switches", "session, ordinal"),
    ("amends", "session, ordinal"),
    ("compactions", "session, ordinal"),
    ("compaction_dropped", "session, kind, id, ordinal"),
    ("message_rows", "session, ordinal, idx, ver"),
    ("message_epochs", "session, start"),
    ("message_views", "session, valid_from"),
    ("turns", "session, rid"),
    ("approvals", "session, aid"),
    ("blob_refs", "digest, session, ordinal"),
    ("prompt_occurrences", "session, ordinal"),
    ("prompt_history", "session, key"),
    ("thread_ops", "session, op_id"),
];

/// The folder of a deleted session, gone: the first log file first, so a rebuild never
/// indexes a half-removed folder. Already-removed parts are skipped.
#[allow(clippy::disallowed_methods, reason = "runs on the maintenance lane job (lane proof argument)")]
fn remove_session_dir(_lane: &InLane<MaintenanceIo>, dir: &Path) -> Result<(), DbError> {
    use crate::fsio::IoOp;
    let gone = |r: std::io::Result<()>, op: IoOp, path: &Path| match r {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(DbError::Write(crate::fsio::err(op, path)(e).to_string()))
        }
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

/// Removes every folder under `sessions` without its first log file; their ids, in name order.
#[allow(clippy::disallowed_methods, reason = "runs on the maintenance lane job (lane proof argument)")]
fn remove_incomplete_dirs(lane: &InLane<MaintenanceIo>, sessions: &Path) -> Result<Vec<String>, DbError> {
    let entries = match std::fs::read_dir(sessions) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(DbError::Write(format!("{}: {e}", sessions.display()))),
    };
    let mut ids = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| DbError::Write(format!("{}: {e}", sessions.display())))?;
        let Ok(name) = entry.file_name().into_string() else { continue };
        let dir = entry.path();
        if dir.is_dir() && !dir.join(crate::log::log_name(0)).is_file() {
            ids.push(name);
        }
    }
    ids.sort();
    for id in &ids {
        remove_session_dir(lane, &sessions.join(id))?;
    }
    Ok(ids)
}

/// The agent-only sessions in list order (`sessions_visibility_recent`).
pub(crate) const AGENT_ONLY_SQL: &str = "SELECT summary FROM sessions WHERE visibility = 'agent-only'
    AND deleted = 0 AND log_id <> '' ORDER BY activity DESC, id";

const UPSERT_SQL: &str = "
INSERT INTO sessions (id, dirty, status, damage, deleted, base_session, log_id, newest_file_no,
    projected_file_no, projected_offset, projected_ordinal, history_rev, row_count, visible_count,
    activity, created_at, updated_at, closed, archived_at, cwd, visibility, owner_session_id,
    parent_session_id, agent, source_type, classification, archived, title_kind, id_key,
    title_fold, preview_fold, cwd_fold, project_fold, id_fold, model_fold, source_fold, summary,
    title, worker, worker_tag, worker_owner, worker_host_pid, agent_tag, agent_owner, user_name)
VALUES (?1, ?2, 'ok', NULL, ?36, ?3, ?4, 0, 0, 0, 0, 0, 0, 0,
    ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
    ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?37)
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
    agent_owner = excluded.agent_owner, user_name = excluded.user_name";

/// Writes the catalog row of `head` with the message state projected so far; the bytes
/// of the list row.
fn upsert(tx: &Transaction<'_>, head: &CatalogHead, dirty: DirtyMark, labels: &PlaceholderLabels) -> rusqlite::Result<usize> {
    upsert_edge(tx, head, dirty, labels, false).map(|(written, _)| written)
}

/// [`upsert`], and with `watch` the change it made to the row.
fn upsert_edge(
    tx: &Transaction<'_>,
    head: &CatalogHead,
    dirty: DirtyMark,
    labels: &PlaceholderLabels,
    watch: bool,
) -> rusqlite::Result<(usize, Option<RowEdge>)> {
    // A fork whose inherited state is still being computed keeps its row until it is done.
    if crate::message_index::has_pending_view(tx, &head.session)? {
        return Ok((0, None));
    }
    let with_incoming = crate::agent_mode::wants_incoming_tail(&head.session);
    let stats = crate::message_index::read_stats(tx, &head.session, with_incoming)?.into_stats(&head.session);
    let row = crate::summary::catalog_row(head, &stats, now_ms());
    let before = if watch {
        tx.prepare_cached("SELECT summary, archived, deleted, user_name FROM sessions WHERE id = ?1")?
            .query_row([&row.id], |r| Ok(StoredRow { summary: r.get(0)?, archived: r.get(1)?, deleted: r.get(2)?, user_name: r.get(3)? }))
            .optional()?
    } else {
        None
    };
    write_row(tx, &row, dirty, labels)?;
    let after = StoredRow { summary: row.summary.clone(), archived: row.archived, deleted: row.deleted, user_name: row.user_name.clone() };
    let edge = (watch && before.as_ref() != Some(&after)).then(|| RowEdge { id: row.id.clone(), before, after });
    Ok((row.summary.len(), edge))
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
    ])?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Writer

type Ack = oneshot::Sender<Result<(), DbError>>;

/// A session whose log a sensitive rewrite replaced (`log_rewrite`'s step 6): its rows to rebuild under `<data>/sessions`,
/// then the blobs the old log named and the new one does not, deleted once no row names them (`blobs` holds the pins).
pub struct Rewritten {
    pub data: PathBuf,
    pub session: String,
    pub dirty: DirtyMark,
    pub superseded: Vec<Digest>,
    pub blobs: crate::blobs::BlobStore,
}

enum Command {
    Upsert { head: Box<CatalogHead>, dirty: DirtyMark, ack: Option<Ack> },
    MarkDirty { session: String, ack: Ack },
    Status { session: String, status: SessionStatus, damage: Option<String>, ack: Ack },
    Delete { session: String, ack: Ack },
    Project { projection: Projection, ack: Option<Ack> },
    Labels { labels: PlaceholderLabels, ack: Ack },
    /// Drop the index rows of a deleted session whose folder is gone.
    Purge { session: String, ack: Ack },
    /// Rebuild a session's rows from its rewritten log ([`Writer::reproject`]).
    Reproject { rewrite: Rewritten, ack: Ack },
    /// Frames of a session the reconcile read from its log; with `finish`, its row and damage,
    /// written clean (`reconcile`). Answered on a channel the lane job blocks on.
    Reconcile {
        session: String,
        frames: Vec<ProjectedFrame>,
        finish: Option<Box<(CatalogHead, Option<String>)>>,
        ack: mpsc::Sender<Result<(), DbError>>,
    },
    /// The writer stops at once and closes its connection ([`SqliteStore::close`]).
    #[cfg(any(test, feature = "test-support"))]
    Close,
}

impl Command {
    #[cfg(any(test, feature = "test-support"))]
    fn closes(&self) -> bool {
        matches!(self, Command::Close)
    }

    #[cfg(not(any(test, feature = "test-support")))]
    fn closes(&self) -> bool {
        false
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
type Upsert = (Box<CatalogHead>, DirtyMark, Vec<Ack>, u64);

struct Writer {
    conn: Connection,
    labels: PlaceholderLabels,
    upserts: HashMap<String, Upsert>,
    small: VecDeque<Command>,
    projections: VecDeque<Pending>,
    refold: bool,
    /// Sessions whose row waits for an inherited state still being computed, with the head
    /// the row is to be built from.
    waiting: HashMap<String, CatalogHead>,
    /// Pending fork views may need a maintenance step.
    views: bool,
    /// Deleted sessions whose rows go in maintenance steps, oldest request first.
    purges: VecDeque<(String, Ack)>,
    /// Sessions whose rows are rebuilt from a rewritten log, once the projections queued before are in.
    reprojects: VecDeque<(Rewritten, Ack)>,
    seq: u64,
    /// Rows per append transaction and per maintenance step (tests shrink them).
    append_rows: usize,
    step_rows: usize,
    /// Told of the rows an append transaction changed, once it committed.
    sink: RowSinkCell,
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
        let conn = open_writer(path)?;
        let stored: Option<String> = conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [LABELS_KEY], |r| r.get(0))
            .optional()?;
        let labels = match stored {
            Some(json) => {
                let [image, video, file]: [String; 3] =
                    serde_json::from_str(&json).map_err(|e| DbError::Rebuild(e.to_string()))?;
                PlaceholderLabels { image, video, file }
            }
            None => PlaceholderLabels::default(),
        };
        let refold: bool = conn
            .query_row("SELECT 1 FROM meta WHERE key = ?1", [REFOLD_JOB], |_| Ok(()))
            .optional()?
            .is_some();
        let views: bool = conn
            .query_row("SELECT 1 FROM message_views WHERE state = 'pending' LIMIT 1", [], |_| Ok(()))
            .optional()?
            .is_some();
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
            append_rows: APPEND_ROWS,
            step_rows: STEP_ROWS,
            sink: RowSinkCell::default(),
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
                let entry = self
                    .upserts
                    .entry(head.session.clone())
                    .or_insert_with(|| (head.clone(), dirty, Vec::new(), seq));
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
            Command::Reproject { rewrite, ack } => self.reprojects.push_back((rewrite, ack)),
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
    /// of them is left in it either. Then each superseded blob no row names any more is deleted (`log_rewrite`'s step 6).
    fn reproject(&mut self, rewrite: &Rewritten) -> Result<(), String> {
        let Rewritten { data, session, dirty, superseded, blobs } = rewrite;
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
            let tx = self.conn.transaction().map_err(|e| e.to_string())?;
            upsert(&tx, &head, dirty, &labels).map_err(|e| e.to_string())?;
            if let Some(damage) = damage {
                set_status_on(&tx, session, SessionStatus::Damaged, Some(&damage)).map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())
        })();
        // A fork view over these rows settles in the maintenance steps.
        self.views = true;
        rows.and_then(|()| truncate_wal(&self.conn))?;
        for digest in superseded {
            blobs.remove_unreferenced(digest, &mut |d| blob_referenced_on(&self.conn, d)).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Every queued rebuild, once no projection is queued before it.
    fn reproject_step(&mut self) {
        while self.projections.is_empty()
            && let Some((rewrite, ack)) = self.reprojects.pop_front()
        {
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
            let sql = format!(
                "DELETE FROM {table} WHERE ({key}) IN (SELECT {key} FROM {table} WHERE session = ?1 LIMIT ?2)"
            );
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
    /// `remove_incomplete_dirs` removed), then every deleted session no fork reads, folder
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
    fn reconcile_apply(
        &mut self,
        session: &str,
        frames: &[ProjectedFrame],
        finish: Option<(CatalogHead, Option<String>)>,
    ) -> Result<(), DbError> {
        apply_all(&mut self.conn, session, frames)?;
        let Some((head, damage)) = finish else { return Ok(()) };
        let tx = self.conn.transaction()?;
        upsert(&tx, &head, DirtyMark::Clear, &self.labels)?;
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
                if let Some(head) = self.waiting.remove(&session) {
                    self.seq += 1;
                    let seq = self.seq;
                    // A newer head queued meanwhile wins.
                    self.upserts.entry(session).or_insert_with(|| (Box::new(head), DirtyMark::Keep, Vec::new(), seq));
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
        let mut rows = 0usize;
        let mut bytes = 0usize;
        let mut waiting: Vec<(String, CatalogHead)> = Vec::new();
        let mut edges: Vec<RowEdge> = Vec::new();
        // The edges the sink was told are about to commit.
        let mut told = 0usize;
        let watch = self.sink.get().is_some();
        let result = (|| -> rusqlite::Result<()> {
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
                        tx.prepare_cached("UPDATE sessions SET deleted = 1, dirty = 0 WHERE id = ?1")?
                            .execute([&session])?;
                        acks.push(ack);
                    }
                    Command::Labels { labels, ack } => {
                        let json = serde_json::to_string(&[&labels.image, &labels.video, &labels.file])
                            .expect("labels encode");
                        let mut meta = tx.prepare_cached("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")?;
                        meta.execute([LABELS_KEY, json.as_str()])?;
                        meta.execute([REFOLD_JOB, "0"])?;
                        self.labels = labels;
                        self.refold = true;
                        acks.push(ack);
                    }
                    #[cfg(any(test, feature = "test-support"))]
                    Command::Close => unreachable!("the writer stops before it queues a close"),
                    Command::Upsert { .. }
                    | Command::Project { .. }
                    | Command::Purge { .. }
                    | Command::Reproject { .. }
                    | Command::Reconcile { .. } => {
                        unreachable!("queued separately")
                    }
                }
            }
            // Projections in arrival order, frame by frame.
            'outer: for pending in self.projections.iter_mut() {
                while pending.next < pending.projection.frames.len() {
                    let frame = &pending.projection.frames[pending.next];
                    let budget = self.append_rows.saturating_sub(rows);
                    if budget == 0 || bytes >= APPEND_BYTES {
                        break 'outer;
                    }
                    let (used, complete) =
                        apply_frame(&tx, &pending.projection.session, frame, budget, self.append_rows)?;
                    rows += used;
                    bytes += 64 * used;
                    if !complete {
                        break 'outer;
                    }
                    pending.next += 1;
                }
                done_projections += 1;
                // The frames are in: the row is built from this projection's own head (a
                // newer explicit upsert of the session wins); queued projections wait.
                let latest = Box::new(pending.projection.head.clone());
                let seq = pending.seq;
                let entry = self
                    .upserts
                    .entry(pending.projection.session.clone())
                    .or_insert_with(|| (latest.clone(), DirtyMark::Keep, Vec::new(), seq));
                if entry.3 < seq {
                    entry.0 = latest;
                    entry.3 = seq;
                }
            }
            // Catalog rows, coalesced per session, after the frames so they see their state.
            // A session with a projection still queued is published by that projection.
            let in_flight: std::collections::HashSet<&str> =
                self.projections.iter().skip(done_projections).map(|p| p.projection.session.as_str()).collect();
            let ids: Vec<String> = self.upserts.keys().filter(|id| !in_flight.contains(id.as_str())).cloned().collect();
            for id in ids {
                if rows >= self.append_rows || bytes >= APPEND_BYTES {
                    break;
                }
                let (head, dirty, waiters, _) = self.upserts.remove(&id).expect("listed");
                rows += 1;
                let (written, edge) = upsert_edge(&tx, &head, dirty, &self.labels, watch)?;
                edges.extend(edge);
                if written == 0 {
                    waiting.push((id.clone(), (*head).clone()));
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
        // Projections: finished ones are acked (and their blob pins released); on a
        // failure every projection in flight is dropped, to be reconciled from its cursor.
        let finished: Vec<Pending> = if result.is_ok() {
            self.projections.drain(..done_projections).collect()
        } else {
            self.projections.drain(..).collect()
        };
        // A projection that finished may have opened a view, or advanced the watermark a
        // pending view waits for.
        let advanced = !finished.is_empty();
        for p in finished {
            acks.extend(p.ack);
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
fn apply_frame(
    tx: &Transaction<'_>,
    session: &str,
    frame: &ProjectedFrame,
    budget: usize,
    cap: usize,
) -> rusqlite::Result<(usize, bool)> {
    let need = frame.rows();
    if need > budget && need <= cap {
        return Ok((0, false));
    }
    let (ordinal, file_no, offset) = pos_params(&frame.pos);
    let len = frame.frame_len as i64;
    let refs = |refs: &[Digest]| -> rusqlite::Result<()> {
        let mut stmt = tx.prepare_cached("INSERT OR IGNORE INTO blob_refs (digest, session, ordinal) VALUES (?1, ?2, ?3)")?;
        for d in refs {
            stmt.execute(params![d.as_str(), session, ordinal])?;
        }
        Ok(())
    };
    let mut used = need;
    match &frame.kind {
        FrameKind::Session { base } => {
            if let Some(base) = base {
                tx.prepare_cached("INSERT OR IGNORE INTO fork_edges (base, child) VALUES (?1, ?2)")?
                    .execute(params![base.session.as_str(), session])?;
                let end = base.end_ordinal_exclusive as i64;
                crate::message_index::open_view(tx, session, ordinal, base.session.as_str(), end, end)?;
            }
        }
        FrameKind::Item { iid, turn, form, model, visible, refs: r, prompt, msg, facets } => {
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
            refs(r)?;
        }
        FrameKind::Amend { iid, refs: r, msg } => {
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
                tx.prepare_cached("UPDATE history SET amend_ordinal = ?3 WHERE session = ?1 AND ordinal = ?2")?
                    .execute(params![session, target, ordinal])?;
            }
            refs(r)?;
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
            // The divider precedes the oldest row the compaction kept.
            let mut boundary = ordinal;
            let mut kept = tx.prepare_cached(
                "SELECT min(ordinal) FROM history WHERE session = ?1 AND iid = ?2 AND ordinal < ?3
                 AND form = 0 AND model = 1 AND superseded_rev IS NULL",
            )?;
            for (iid, _) in rows {
                if let Some(at) = kept.query_row(params![session, iid, ordinal], |r| r.get::<_, Option<i64>>(0))? {
                    boundary = boundary.min(at);
                }
            }
            tx.prepare_cached(
                "INSERT OR REPLACE INTO compactions (session, ordinal, cid, file_no, frame_offset, frame_len,
                 boundary, at, drop_mode, silent, superseded_rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)",
            )?
            .execute(params![session, ordinal, cid, file_no, offset, len, boundary, at, *mode as i64, i64::from(*silent)])?;
            if let Some(dropped) = dropped {
                let mut put = tx.prepare_cached(
                    "INSERT OR IGNORE INTO compaction_dropped (session, kind, id, ordinal) VALUES (?1, ?2, ?3, ?4)",
                )?;
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
                tx.prepare_cached("UPDATE turns SET end_ordinal = ?3, phase = ?4 WHERE session = ?1 AND rid = ?2")?
                    .execute(params![session, rid, ordinal, serde_name(ended)])?;
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
                tx.prepare_cached("DELETE FROM approvals WHERE session = ?1 AND aid = ?2")?
                    .execute(params![session, aid])?;
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
    tx.prepare_cached(
        "UPDATE sessions SET projected_file_no = ?2, projected_offset = ?3, projected_ordinal = ?4,
         newest_file_no = max(newest_file_no, ?2), history_rev = ?5, row_count = ?6, visible_count = ?7
         WHERE id = ?1",
    )?
    .execute(params![
        session,
        file_no,
        offset + len,
        ordinal + 1,
        frame.history_rev as i64,
        frame.rows as i64,
        frame.visible_rows as i64
    ])?;
    Ok((used, true))
}

/// Points `key`'s prompt-history row at its newest live occurrence, or removes it.
fn refresh_prompt(tx: &Transaction<'_>, session: &str, key: &str) -> rusqlite::Result<()> {
    let newest: Option<(i64, String)> = tx
        .prepare_cached(PROMPT_NEWEST_SQL)?
        .query_row([session, key], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    match newest {
        Some((ordinal, text)) => tx
            .prepare_cached("UPDATE prompt_history SET ordinal = ?3, text = ?4 WHERE session = ?1 AND key = ?2")?
            .execute(params![session, key, ordinal, text])?,
        None => tx
            .prepare_cached("DELETE FROM prompt_history WHERE session = ?1 AND key = ?2")?
            .execute([session, key])?,
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
    /// The writer thread, joined by [`SqliteStore::close`].
    #[cfg(any(test, feature = "test-support"))]
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
    #[allow(clippy::disallowed_methods, reason = "runs on the maintenance lane job (lane proof argument)")]
    pub fn open(
        lane: &InLane<MaintenanceIo>,
        thread: SqliteWriterThread,
        read_lane: InteractiveIo,
        data: &Path,
    ) -> Result<SqliteStore, DbError> {
        // A log rewrite a stop cut short is settled first (`log_rewrite`'s step table); one past its swap gets its rows
        // rebuilt and its superseded blobs deleted below, before any session opens. No writer exists yet, so a store
        // of its own holds every pin there is (none).
        let blobs = crate::blobs::BlobStore::new(data);
        let rewritten = crate::log_rewrite::recover(lane, data, &crate::log::OsIo, &blobs).map_err(|e| DbError::Write(e.to_string()))?;
        let incomplete = remove_incomplete_dirs(lane, &data.join("sessions"))?;
        let path = data.join(INDEX_FILE);
        let path = path.as_path();
        let mut writer = match path.exists().then(|| Writer::start(path)) {
            Some(Ok(writer)) => writer,
            Some(Err(e)) if !needs_rebuild(&e) => return Err(e),
            _ => {
                rebuild(lane, data, path)?;
                Writer::start(path).map_err(|e| match e {
                    DbError::Rebuild(why) => DbError::Write(format!("rebuilt index refused: {why}")),
                    e => e,
                })?
            }
        };
        writer.boot_purge(lane, data, &incomplete)?;
        for session in rewritten {
            crate::log_rewrite::finish(lane, data, &session, &mut |superseded| {
                let rewrite = Rewritten { data: data.to_path_buf(), session: session.clone(), dirty: DirtyMark::Clear, superseded, blobs: blobs.clone() };
                writer.reproject(&rewrite)
            })
            .map_err(|e| DbError::Write(e.to_string()))?;
        }
        let dirty: Vec<String> = writer
            .conn
            .prepare_cached("SELECT id FROM sessions WHERE dirty = 1 ORDER BY id")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let rows = writer.sink.clone();
        let (sender, rx) = mpsc::channel();
        let handle = thread
            .spawn_thread("mixdog-index-writer", move |_| writer.run(rx))
            .map_err(|e| DbError::Write(e.to_string()))?;
        #[cfg(not(any(test, feature = "test-support")))]
        drop(handle);
        let (gate, reconciler) = gate::Gate::new(ReadPool::new(path, read_lane), sender, !dirty.is_empty());
        let store = SqliteStore {
            shared: Arc::new(Shared {
                path: path.to_path_buf(),
                gate,
                rows,
                #[cfg(any(test, feature = "test-support"))]
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

    /// Test teardown: the writer stops at once (what is queued behind the close is dropped, its waiters answered `Stopped`) and
    /// its connection closes, and the read pool's idle connections close, so the database files can be removed while other
    /// handles still exist. Returns once the writer thread has ended.
    #[cfg(any(test, feature = "test-support"))]
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

    /// Catalog row write, coalesced per session; resolves once committed.
    /// The row is built by `summary::catalog_row` from `head` and the session's projected
    /// message state when it is written.
    pub async fn upsert(&self, head: CatalogHead, dirty: DirtyMark) -> Result<(), DbError> {
        self.ask(|ack| Command::Upsert { head: Box::new(head), dirty, ack: Some(ack) }).await
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

    /// The projection of a barrier; resolves when every frame is committed.
    pub async fn project(&self, projection: Projection) -> Result<(), DbError> {
        self.ask(|ack| Command::Project { projection, ack: Some(ack) }).await
    }

    /// The rows of `session` (under `<data>/sessions`) rebuilt from its rewritten log, the replaced rows overwritten in
    /// the database and gone from the WAL, then its superseded blobs no row names deleted; resolves once that is done.
    pub async fn reproject(&self, rewrite: Rewritten) -> Result<(), DbError> {
        self.ask(|ack| Command::Reproject { rewrite, ack }).await
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

    pub async fn blob_referenced(&self, digest: &Digest) -> Result<bool, DbError> {
        let digest = digest.clone();
        self.read(move |c| blob_referenced_on(c, &digest)).await
    }

    /// The session's prompt history (`OpenedLog.prompts`): the newest 50 distinct prompts
    /// of its lineage, newest first: its own (`prompt_history`), then each base's below
    /// the fork point and `cut`, live as of the fork (as history pages). Inside the open's
    /// J2 job on the read lane.
    pub fn prompts_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
    ) -> Result<Vec<String>, DbError> {
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

    /// GC condition 3 (SM §9) for `BlobStore::collect_shard`, which runs on the
    /// maintenance lane: answered on that lane's thread.
    pub fn blob_referenced_on_lane(&self, _lane: &InLane<MaintenanceIo>, digest: &Digest) -> Result<bool, DbError> {
        self.shared.gate.with(|c| blob_referenced_on(c, digest))
    }

    /// P §9.2 thread-scope lookup: the indexed op of `session` (records not yet projected
    /// are the session actor's to check).
    pub async fn thread_op(&self, session: &str, op_id: &str) -> Result<Option<ThreadOp>, DbError> {
        let (session, op_id) = (session.to_owned(), op_id.to_owned());
        self.read(move |c| thread_op_on(c, &session, &op_id)).await
    }

    /// `thread_op` inside a job already on the read lane: answered on the job's thread, so the job never waits for a lane slot
    /// behind itself.
    pub fn thread_op_on_lane(&self, _lane: &InLane<InteractiveIo>, session: &str, op_id: &str) -> Result<Option<ThreadOp>, DbError> {
        self.shared.gate.with(|c| thread_op_on(c, session, op_id))
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
    pub async fn dividers(
        &self,
        lineage: Vec<LineageLevel>,
        cut: Option<u64>,
        level: usize,
        from: u64,
        to: u64,
    ) -> Result<Vec<Divider>, DbError> {
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
        self.read(move |c| {
            Ok(c.prepare_cached("SELECT summary FROM sessions WHERE id = ?1 AND log_id <> '' AND deleted = 0")?
                .query_row([&session], |r| r.get(0))
                .optional()?)
        })
        .await
    }

    /// The raw header `title` of a session (1.4.5 `readStoredSessionMetadata`'s
    /// `session.title || null`); `None` when it has none, is not listed or was deleted.
    pub async fn title(&self, session: &str) -> Result<Option<String>, DbError> {
        let session = session.to_owned();
        self.read(move |c| {
            Ok(c.prepare_cached("SELECT title FROM sessions WHERE id = ?1 AND log_id <> '' AND deleted = 0")?
                .query_row([&session], |r| r.get(0))
                .optional()?
                .flatten())
        })
        .await
    }

    /// Whether the session was deleted (its header's delete mark, or `mark_deleted`);
    /// `None` for a session the index does not hold (never created, or purged).
    pub async fn deleted(&self, session: &str) -> Result<Option<bool>, DbError> {
        let session = session.to_owned();
        self.read(move |c| {
            Ok(c.prepare_cached("SELECT deleted FROM sessions WHERE id = ?1")?
                .query_row([&session], |r| r.get(0))
                .optional()?)
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
            let found = self.read(|c| Ok(c.prepare_cached(PURGEABLE_SQL)?.query_row([], |r| r.get::<_, String>(0)).optional()?));
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
            let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| {
                let worker = serde_json::from_str(r.get_ref(1)?.as_str()?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(e))
                })?;
                Ok(WorkerRow { session: r.get(0)?, worker, summary: r.get(2)? })
            })?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
        .await
    }

    /// The newest session `owner` ran under `tag` (1.4.5 `lastTagSession`, open or closed),
    /// by the session's own `agentTag` (a cleaned tag) and owner.
    pub async fn newest_tag_session(&self, tag: &str, owner: &str) -> Result<Option<TagSession>, DbError> {
        let (tag, owner) = (tag.to_owned(), owner.to_owned());
        self.read(move |c| {
            Ok(c.prepare_cached(crate::worker::NEWEST_TAG_SQL)?
                .query_row([&tag, &owner], |r| Ok(TagSession { session: r.get(0)?, summary: r.get(1)? }))
                .optional()?)
        })
        .await
    }

    /// The list rows of the agent-only sessions (`visibility` 'agent-only'), the
    /// candidates of 1.4.5 agent rehydration; most recent activity first.
    pub async fn agent_only_sessions(&self) -> Result<Vec<String>, DbError> {
        self.read(|c| {
            let mut stmt = c.prepare_cached(AGENT_ONLY_SQL)?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
        .await
    }

    /// Session search (FORMAT.md §8.2): summaries in result order.
    pub async fn search(&self, query: &str, limit: usize, after: Option<SearchCursor>) -> Result<Vec<String>, DbError> {
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
                    |r| r.get(0),
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

    /// The live `compacted` frame whose replacement holds the entry `iid` (such as the
    /// summary, which has no history row), as the reader of `lineage` with `cut` sees it:
    /// its `ordinal` is that of a `model_switch` anchor on the entry (FORMAT.md §5.3). The
    /// newest such frame when later replacements kept the entry; `None` when no live one
    /// holds it.
    pub async fn compaction_entry(
        &self,
        lineage: Vec<LineageLevel>,
        cut: Option<u64>,
        iid: String,
    ) -> Result<Option<CompactionEntry>, DbError> {
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
fn compaction_entry_on(
    c: &Connection,
    lineage: &[LineageLevel],
    cut: Option<u64>,
    iid: &str,
) -> Result<Option<CompactionEntry>, DbError> {
    for (i, level) in lineage.iter().enumerate() {
        let asof = level.end.map_or(i64::MAX, |v| v.min(i64::MAX as u64) as i64);
        let bound = crate::archive_index::level_bound(lineage, cut, i);
        let found = c
            .prepare_cached(COMPACTION_ENTRY_SQL)?
            .query_row(params![level.session, iid, asof, bound], |r| {
                Ok(CompactionEntry { ordinal: r.get::<_, i64>(0)? as u64, cid: r.get(1)? })
            })
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
pub fn project_index(
    data: &Path,
    db: &Path,
    sessions: &[String],
) -> Result<(), String> {
    let mut conn = open_writer(db).map_err(|e| e.to_string())?;
    let blobs = crate::blobs::BlobStore::new(data);
    let mut heads = Vec::new();
    for id in sessions {
        let dir = data.join("sessions").join(id);
        let mut fold = None;
        let damage = project_session(&mut conn, &dir, &blobs, &mut fold, None)
            .map_err(|e| format!("{id}: {e}"))?
            .err()
            .map(|(error, at)| damage_text(&dir, at, &error));
        let head = fold.as_ref().map_or_else(|| unreadable_head(id), CatalogHead::of);
        heads.push((head, damage));
    }
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
        upsert(&tx, &head, DirtyMark::Clear, &labels).map_err(|e| e.to_string())?;
        if let Some(damage) = damage {
            set_status_on(&tx, &head.session, SessionStatus::Damaged, Some(&damage)).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "DELETE").map_err(|e| e.to_string())?;
    Ok(())
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
        upsert(&tx, head, DirtyMark::Clear, &PlaceholderLabels::default()).map_err(|e| e.to_string())?;
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
fn reconcile(
    _lane: &InLane<InteractiveIo>,
    pool: &ReadPool,
    sender: &mpsc::Sender<Command>,
    data: &Path,
    dirty: Vec<String>,
) -> Result<bool, String> {
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
fn project_session(
    to: &mut impl ProjectTo,
    dir: &Path,
    blobs: &crate::blobs::BlobStore,
    fold: &mut Option<crate::fold::Fold>,
    from: Option<FramePos>,
) -> Result<Result<(), LogFailure>, String> {
    use crate::fold::Fold;
    use crate::fold::NoIndex;
    use crate::log::ForwardEnd;
    use crate::schema::record::Record;
    let log = |e: String| (e, None);
    let first = match crate::log::first_ordinal_unlaned(dir) {
        Ok(first) => first,
        Err(e) => return Ok(Err(log(e.to_string()))),
    };
    let mut pos = FramePos { ordinal: first, file_no: 0, offset: 0 };
    let mut resolve = |b: &crate::schema::blob::BodyBlob| {
        blobs.read_unlaned(&b.descriptor().digest).map_err(|e| e.to_string())
    };
    loop {
        let read = match crate::log::read_forward_unlaned(dir, pos, APPEND_BYTES as u64) {
            Ok(read) => read,
            Err(e) => return Ok(Err(log(e.to_string()))),
        };
        let mut frames = Vec::with_capacity(read.frames.len());
        let mut failure = None;
        for (record, at, frame_len) in &read.frames {
            let folded = match fold.as_mut() {
                None => match record {
                    Record::Session(s) => crate::fold::resolve_slot(&s.header, &mut resolve).map(|header| {
                        *fold = Some(Fold::from_session(s, header, *at));
                        true
                    }),
                    _ => Err("the first frame is not a session frame".to_owned()),
                },
                Some(f) => f.prepare([record], &NoIndex, &mut resolve).map_err(|e| e.to_string()).map(|mut effects| {
                    f.apply(effects.pop().expect("one effect"), *at);
                    false
                }),
            };
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
            let (kind, op) = match crate::projection::project(record, &mut resolve) {
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
                history_rev: f.history_rev,
                rows: f.rows,
                visible_rows: f.visible_rows,
            });
        }
        let session = fold.as_ref().map(|f| f.session.clone()).unwrap_or_default();
        to.frames(&session, frames)?;
        if let Some(failure) = failure {
            return Ok(Err(failure));
        }
        match read.next {
            ForwardEnd::More(next) => pos = next,
            ForwardEnd::Done { .. } if fold.is_some() => return Ok(Ok(())),
            ForwardEnd::Done { .. } => return Ok(Err(log("the log holds no frame".into()))),
            ForwardEnd::Damaged(d) => return Ok(Err(("a frame fails its check".into(), Some(d)))),
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
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
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

fn dividers_on(
    c: &Connection,
    lineage: &[LineageLevel],
    cut: Option<u64>,
    level: usize,
    from: u64,
    to: u64,
) -> Result<Vec<Divider>, DbError> {
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
            let place = crate::archive_index::divider_place(c, lineage, cut, i, ordinal as u64, own_boundary as u64)?;
            if place.0 == level && place.1 >= from && place.1 < to {
                // The records anchored here: the compaction's own log and each later
                // level's up to its fork point, keyed (entry position, level, record).
                let mut found = Vec::new();
                for (rank, holder) in lineage[..=i].iter().rev().enumerate() {
                    let end = holder.end.map_or(i64::MAX, clamp);
                    let mut stmt = c.prepare_cached(ENTRY_SWITCHES_SQL)?;
                    let rows = stmt.query_map(params![holder.session, ordinal, home.session, end], |s| {
                        Ok((
                            (s.get::<_, i64>(0)?, rank, s.get::<_, i64>(1)?),
                            ModelSwitchEntry { provider: s.get(2)?, model_id: s.get(3)?, at: s.get(4)? },
                        ))
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

fn page_on(
    c: &Connection,
    lineage: &[LineageLevel],
    cut: Option<u64>,
    cursor: Option<PageCursor>,
    limit: usize,
) -> Result<Page, DbError> {
    {
        {
            let rev: i64 = c
                .prepare_cached("SELECT history_rev FROM sessions WHERE id = ?1")?
                .query_row([&lineage[0].session], |r| r.get(0))
                .optional()?
                .unwrap_or(0);
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
                // A child sees a base row unless a rewind before the fork point superseded it.
                let fork_end = level.end;
                let mut before = fork_end.map_or(cur.before, |e| cur.before.min(e));
                if cur.level > 0
                    && let Some(cut) = cut
                {
                    before = before.min(cut);
                }
                let mut stmt = c.prepare_cached(PAGE_SQL)?;
                let want = (limit - out.len()) as i64;
                let floor = fork_end.map_or(i64::MAX, |e| e as i64);
                let mut rows = stmt.query(params![level.session, before.min(i64::MAX as u64) as i64, floor, want])?;
                let mut got = 0;
                let mut full = false;
                while let Some(r) = rows.next()? {
                    got += 1;
                    let frame_len = r.get::<_, i64>(7)? as u64;
                    let amend = match r.get::<_, Option<i64>>(8)? {
                        Some(o) => Some((
                            FramePos { ordinal: o as u64, file_no: r.get(9)?, offset: r.get::<_, i64>(10)? as u64 },
                            r.get::<_, i64>(11)? as u64,
                        )),
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
                                compaction: FramePos {
                                    ordinal: k.get::<_, i64>(0)? as u64,
                                    file_no: k.get(1)?,
                                    offset: k.get::<_, i64>(2)? as u64,
                                },
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
pub(crate) const KEPT_SQL: &str =
    "SELECT c.ordinal, c.file_no, c.frame_offset, c.frame_len, m.idx FROM message_rows m
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
pub(crate) const PAGE_SQL: &str =
    "SELECT h.ordinal, h.iid, h.turn, h.form, h.model, h.file_no, h.frame_offset, h.frame_len,
       a.ordinal, a.file_no, a.frame_offset, a.frame_len,
       h.facets
     FROM history h LEFT JOIN amends a ON a.session = h.session AND a.ordinal = h.amend_ordinal
     WHERE h.session = ?1 AND h.ordinal < ?2 AND h.visible = 1
       AND (h.superseded_rev IS NULL OR h.superseded_rev >= ?3)
     ORDER BY h.ordinal DESC LIMIT ?4";

pub(crate) const PROJECTED_SQL: &str =
    "SELECT projected_ordinal, projected_file_no, projected_offset FROM sessions WHERE id = ?1";

pub(crate) const BLOB_REF_SQL: &str = "SELECT 1 FROM blob_refs WHERE digest = ?1 LIMIT 1";

pub(crate) const THREAD_OP_SQL: &str = "SELECT method, payload_digest, state, ordinal, file_no, frame_offset,
     frame_len FROM thread_ops WHERE session = ?1 AND op_id = ?2";

/// The newest live occurrence of one prompt key.
pub(crate) const PROMPT_NEWEST_SQL: &str = "SELECT ordinal, text FROM prompt_occurrences
     WHERE session = ?1 AND key = ?2 AND superseded_rev IS NULL ORDER BY ordinal DESC LIMIT 1";

/// 1.4.5 `PROMPT_HISTORY_LIMIT`.
pub const PROMPT_HISTORY_LIMIT: usize = 50;

/// The newest distinct prompts of one session, newest first.
pub(crate) const PROMPTS_SQL: &str =
    "SELECT key, text FROM prompt_history WHERE session = ?1 ORDER BY ordinal DESC LIMIT ?2";

/// A base level's prompt occurrences below `?2`, live for a fork at `?3`, newest first;
/// read until the lineage has 50 distinct keys.
pub(crate) const BASE_PROMPTS_SQL: &str = "SELECT key, text FROM prompt_occurrences
     WHERE session = ?1 AND ordinal < ?2 AND (superseded_rev IS NULL OR superseded_rev >= ?3)
     ORDER BY ordinal DESC";

pub(crate) const LIVE_ROWS_SQL: &str = "SELECT count(*), coalesce(sum(visible), 0) FROM history
     WHERE session = ?1 AND ordinal >= ?2 AND ordinal < ?3 AND superseded_rev IS NULL";

pub(crate) const LIVE_COMPACTION_SQL: &str = "SELECT ordinal, file_no, frame_offset FROM compactions
     WHERE session = ?1 AND ordinal < ?2 AND superseded_rev IS NULL ORDER BY ordinal DESC LIMIT 1";

/// `(sql, ?1, limit)` of a session search (FORMAT.md §8.2); `?3..?5` are the keyset.
pub(crate) fn search_statement(query: &str, limit: usize) -> (String, String, usize) {
    let needle = fold(query.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'));
    let keyset = "(?3 IS NULL OR s.archived > ?3 OR (s.archived = ?3 AND (s.activity < ?4
        OR (s.activity = ?4 AND s.id_key > ?5))))";
    let len = needle.chars().count();
    let (sql, limit) = match len {
        0 => (
            format!(
                "SELECT s.summary FROM sessions s WHERE s.deleted = 0 AND s.classification IN ('task','project')
                 AND s.archived = 0 AND ?1 = ?1 AND {keyset}
                 ORDER BY s.archived, s.activity DESC, s.id_key LIMIT ?2"
            ),
            limit.min(RECENT_SESSION_ROWS),
        ),
        1 | 2 => (
            format!(
                "SELECT s.summary FROM sessions s WHERE s.deleted = 0 AND s.classification IN ('task','project')
                 AND (instr(s.title_fold, ?1) OR instr(s.preview_fold, ?1) OR instr(s.cwd_fold, ?1)
                   OR instr(s.project_fold, ?1) OR instr(s.id_fold, ?1) OR instr(s.model_fold, ?1)
                   OR instr(s.source_fold, ?1)) AND {keyset}
                 ORDER BY s.archived, s.activity DESC, s.id_key LIMIT ?2"
            ),
            limit,
        ),
        _ => (
            format!(
                "SELECT s.summary FROM session_search f JOIN sessions s ON s.sid = f.rowid
                 WHERE session_search MATCH ?1 AND s.deleted = 0 AND s.classification IN ('task','project')
                 AND {keyset} ORDER BY s.archived, s.activity DESC, s.id_key LIMIT ?2"
            ),
            limit,
        ),
    };
    let arg = if len >= 3 { format!("\"{}\"", needle.replace('"', "\"\"")) } else { needle };
    (sql, arg, limit)
}

fn projected_on(c: &Connection, session: &str) -> Result<Option<FramePos>, DbError> {
    Ok(c.prepare_cached(PROJECTED_SQL)?
        .query_row([session], |r| {
            Ok(FramePos { ordinal: r.get::<_, i64>(0)? as u64, file_no: r.get(1)?, offset: r.get::<_, i64>(2)? as u64 })
        })
        .optional()?)
}

fn thread_op_on(c: &Connection, session: &str, op_id: &str) -> Result<Option<ThreadOp>, DbError> {
    Ok(c.prepare_cached(THREAD_OP_SQL)?
        .query_row([session, op_id], |r| {
            let state: String = r.get(2)?;
            Ok(ThreadOp {
                method: r.get(0)?,
                payload_digest: r.get(1)?,
                state: serde_json::from_value(serde_json::Value::String(state)).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))
                })?,
                pos: FramePos { ordinal: r.get::<_, i64>(3)? as u64, file_no: r.get(4)?, offset: r.get::<_, i64>(5)? as u64 },
                frame_len: r.get::<_, i64>(6)? as u64,
            })
        })
        .optional()?)
}

fn fenced_ops_on(c: &Connection, session: &str) -> Result<Vec<String>, DbError> {
    let fenced = serde_name(&crate::schema::record::OpState::Fenced);
    let mut rows = c.prepare_cached("SELECT op_id FROM thread_ops WHERE session = ?1 AND state = ?2")?;
    let ids = rows.query_map([session, fenced.as_str()], |r| r.get::<_, String>(0))?;
    Ok(ids.collect::<Result<Vec<_>, _>>()?)
}

pub(crate) fn blob_referenced_on(c: &Connection, digest: &Digest) -> Result<bool, DbError> {
    Ok(c.prepare_cached(BLOB_REF_SQL)?
        .query_row([digest.as_str()], |_| Ok(()))
        .optional()?
        .is_some())
}

/// Read connections of one database. `run` executes a read as a job on the read lane,
/// so no caller blocks a runtime thread; `with` runs it on the calling thread, for code
/// already inside a lane job (the fold's lookups on the durability lane, GC on the
/// maintenance lane).
pub(crate) struct ReadPool {
    path: PathBuf,
    lane: InteractiveIo,
    conns: Mutex<Vec<Connection>>,
    /// Test support only: `true` once [`close`](Self::close) has run. Every read holds it shared from before it takes or opens a
    /// connection until that connection is back or closed, and `close` takes it exclusively, so `close` waits for the reads in
    /// flight and no read opens a connection after it returned. A release build has no close: its pool keeps its connections until
    /// the last owner of the store drops it.
    #[cfg(any(test, feature = "test-support"))]
    closed: std::sync::RwLock<bool>,
}

impl ReadPool {
    pub(crate) fn new(path: &Path, lane: InteractiveIo) -> Arc<ReadPool> {
        Arc::new(ReadPool {
            path: path.to_path_buf(),
            lane,
            conns: Mutex::new(Vec::new()),
            #[cfg(any(test, feature = "test-support"))]
            closed: std::sync::RwLock::new(false),
        })
    }

    /// Test support only (a test's data folder closes its databases before it is removed): waits for the reads in flight, closes
    /// every pooled connection, and makes every later read fail as the stopped writer does.
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn close(&self) {
        let mut closed = self.closed.write().unwrap_or_else(std::sync::PoisonError::into_inner);
        *closed = true;
        self.conns.lock().expect("pool lock").clear();
    }

    pub(crate) fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T, DbError>) -> Result<T, DbError> {
        #[cfg(any(test, feature = "test-support"))]
        let closed = self.closed.read().unwrap_or_else(std::sync::PoisonError::into_inner);
        #[cfg(any(test, feature = "test-support"))]
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
        let job = self
            .lane
            .submit(&CancellationToken::new(), move |lane| pool.with(|c| f(lane, c)))
            .map_err(|_| DbError::LaneFull);
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
            Ok(Ok(c.prepare_cached(LIVE_ROWS_SQL)?.query_row(params![session, from as i64, to as i64], |r| {
                Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64))
            })?))
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
