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

use crate::fold::LineageIndex;
use crate::fold::LookupError;
use crate::projection::FrameKind;
use crate::projection::ProjectedFrame;
use crate::projection::Projection;
use crate::schema::bounded::Digest;
use crate::schema::checkpoint::FramePos;
use crate::schema::record::ApprovalPhase;
use crate::schema::record::Form;
use crate::schema::record::RunPhase;
use crate::schema::sql::INDEX_APPLICATION_ID;
use crate::schema::sql::INDEX_DDL;
use crate::schema::sql::INDEX_USER_VERSION;
use crate::schema::sql::session_id_key;
use crate::summary::CatalogHead;
use crate::title::PlaceholderLabels;
use crate::title::TitleKind;
use crate::title::session_display_title;

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
    /// Missing tables, another `application_id`/`user_version`: rebuild from the logs.
    #[error("index database needs a rebuild: {0}")]
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

fn open_writer(path: &Path) -> Result<Connection, DbError> {
    open_schema(path, INDEX_DDL, INDEX_APPLICATION_ID, INDEX_USER_VERSION)
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

const UPSERT_SQL: &str = "
INSERT INTO sessions (id, dirty, status, damage, deleted, base_session, log_id, newest_file_no,
    projected_file_no, projected_offset, projected_ordinal, history_rev, row_count, visible_count,
    activity, created_at, updated_at, closed, archived_at, cwd, visibility, owner_session_id,
    parent_session_id, agent, source_type, classification, archived, title_kind, id_key,
    title_fold, preview_fold, cwd_fold, project_fold, id_fold, model_fold, source_fold, summary)
VALUES (?1, ?2, 'ok', NULL, 0, ?3, ?4, 0, 0, 0, 0, 0, 0, 0,
    ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
    ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)
ON CONFLICT(id) DO UPDATE SET
    dirty = CASE WHEN ?28 THEN dirty ELSE excluded.dirty END,
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
    summary = excluded.summary";

/// Writes the catalog row of `head` with the message state projected so far; the bytes
/// of the list row.
fn upsert(tx: &Transaction<'_>, head: &CatalogHead, dirty: DirtyMark, labels: &PlaceholderLabels) -> rusqlite::Result<usize> {
    // A fork whose inherited state is still being computed keeps its row until it is done.
    if crate::message_index::has_pending_view(tx, &head.session)? {
        return Ok(0);
    }
    let with_incoming = crate::agent_mode::wants_incoming_tail(&head.session);
    let stats = crate::message_index::read_stats(tx, &head.session, with_incoming)?.into_stats(&head.session);
    let row = crate::summary::catalog_row(head, &stats, now_ms());
    write_row(tx, &row, dirty, labels)?;
    Ok(row.summary.len())
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
    ])?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Writer

type Ack = oneshot::Sender<Result<(), DbError>>;

enum Command {
    Upsert { head: Box<CatalogHead>, dirty: DirtyMark, ack: Option<Ack> },
    MarkDirty { session: String, ack: Ack },
    Status { session: String, status: SessionStatus, damage: Option<String>, ack: Ack },
    Delete { session: String, ack: Ack },
    Project { projection: Projection, ack: Option<Ack> },
    Labels { labels: PlaceholderLabels, ack: Ack },
}

/// A projection being applied: frames before `next` are committed.
struct Pending {
    projection: Projection,
    next: usize,
    ack: Option<Ack>,
}

struct Writer {
    conn: Connection,
    labels: PlaceholderLabels,
    upserts: HashMap<String, (Box<CatalogHead>, DirtyMark, Vec<Ack>)>,
    small: VecDeque<Command>,
    projections: VecDeque<Pending>,
    refold: bool,
    /// The newest header side seen per session (arrival order): the row a finished
    /// projection writes is built from it, so a later header change is never lost.
    heads: HashMap<String, CatalogHead>,
    /// Sessions whose row waits for an inherited state still being computed.
    waiting: std::collections::HashSet<String>,
    /// Pending fork views may need a maintenance step.
    views: bool,
}

const LABELS_KEY: &str = "ui:placeholder_labels";
const REFOLD_JOB: &str = "job:refold_titles";

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
            .query_row("SELECT 1 FROM message_views WHERE state = 'pending' AND superseded_rev IS NULL LIMIT 1", [], |_| Ok(()))
            .optional()?
            .is_some();
        Ok(Writer {
            conn,
            labels,
            upserts: HashMap::new(),
            small: VecDeque::new(),
            projections: VecDeque::new(),
            refold,
            heads: HashMap::new(),
            waiting: std::collections::HashSet::new(),
            views,
        })
    }

    fn take(&mut self, cmd: Command) {
        match cmd {
            Command::Upsert { head, dirty, ack } => {
                self.heads.insert(head.session.clone(), (*head).clone());
                let entry = self
                    .upserts
                    .entry(head.session.clone())
                    .or_insert_with(|| (head.clone(), dirty, Vec::new()));
                // Coalesce: newest fields; a Set/Clear outranks an earlier Keep.
                entry.0 = head;
                if dirty != DirtyMark::Keep {
                    entry.1 = dirty;
                }
                entry.2.extend(ack);
            }
            Command::Project { projection, ack } => {
                self.heads.insert(projection.session.clone(), projection.head.clone());
                self.projections.push_back(Pending { projection, next: 0, ack });
            }
            other => self.small.push_back(other),
        }
    }

    fn idle(&self) -> bool {
        self.upserts.is_empty() && self.small.is_empty() && self.projections.is_empty() && !self.refold && !self.views
    }

    /// One bounded step of the pending fork views; a finished view rebuilds its row.
    fn view_step(&mut self) {
        let step = (|| -> rusqlite::Result<crate::message_index::Step> {
            let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let step = crate::message_index::view_step(&tx, STEP_ROWS)?;
            tx.commit()?;
            Ok(step)
        })();
        match step {
            Ok(crate::message_index::Step::Progress) => {}
            Ok(crate::message_index::Step::Done(session)) => {
                self.waiting.remove(&session);
                if let Some(head) = self.heads.get(&session) {
                    self.upserts.entry(session).or_insert_with(|| (Box::new(head.clone()), DirtyMark::Keep, Vec::new()));
                }
            }
            // Idle, or failed: new work re-arms it.
            Ok(crate::message_index::Step::Idle) | Err(_) => self.views = false,
        }
    }

    fn run(mut self, rx: mpsc::Receiver<Command>) {
        loop {
            if self.idle() {
                match rx.recv() {
                    Ok(cmd) => self.take(cmd),
                    Err(_) => return,
                }
            }
            while let Ok(cmd) = rx.try_recv() {
                self.take(cmd);
            }
            self.append_transaction();
            if self.refold {
                self.maintenance_step();
            }
            if self.views {
                self.view_step();
            }
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
        let mut waiting: Vec<String> = Vec::new();
        let result = (|| -> rusqlite::Result<()> {
            let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            // Small commands (dirty marks, status): one row each.
            while rows < APPEND_ROWS
                && let Some(cmd) = self.small.pop_front()
            {
                rows += 1;
                match cmd {
                    Command::MarkDirty { session, ack } => {
                        tx.prepare_cached("UPDATE sessions SET dirty = 1 WHERE id = ?1")?.execute([&session])?;
                        acks.push(ack);
                    }
                    Command::Status { session, status, damage, ack } => {
                        tx.prepare_cached("UPDATE sessions SET status = ?2, damage = ?3 WHERE id = ?1")?
                            .execute(params![session, status.as_str(), damage])?;
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
                    Command::Upsert { .. } | Command::Project { .. } => unreachable!("queued separately"),
                }
            }
            // Projections in arrival order, frame by frame.
            'outer: for pending in self.projections.iter_mut() {
                while pending.next < pending.projection.frames.len() {
                    let frame = &pending.projection.frames[pending.next];
                    let budget = APPEND_ROWS.saturating_sub(rows);
                    if budget == 0 || bytes >= APPEND_BYTES {
                        break 'outer;
                    }
                    let (used, complete) = apply_frame(&tx, &pending.projection.session, frame, budget)?;
                    rows += used;
                    bytes += 64 * used;
                    if !complete {
                        break 'outer;
                    }
                    pending.next += 1;
                }
                done_projections += 1;
                // The frames are in: the row is rebuilt from the header side they carry
                // and the message state (an explicit upsert of the session wins).
                let latest = Box::new(self.heads.get(&pending.projection.session).unwrap_or(&pending.projection.head).clone());
                let entry = self
                    .upserts
                    .entry(pending.projection.session.clone())
                    .or_insert_with(|| (latest.clone(), DirtyMark::Keep, Vec::new()));
                entry.0 = latest;
            }
            // Catalog rows, coalesced per session, after the frames so they see their state.
            let ids: Vec<String> = self.upserts.keys().cloned().collect();
            for id in ids {
                if rows >= APPEND_ROWS || bytes >= APPEND_BYTES {
                    break;
                }
                let (head, dirty, waiters) = self.upserts.remove(&id).expect("listed");
                rows += 1;
                let written = upsert(&tx, &head, dirty, &self.labels)?;
                if written == 0 {
                    waiting.push(id.clone());
                }
                bytes += written;
                acks.extend(waiters);
            }
            tx.commit()
        })();
        let result = result.map_err(|e| e.to_string());
        // Projections: finished ones are acked (and their blob pins released); on a
        // failure every projection in flight is dropped, to be reconciled from its cursor.
        let finished: Vec<Pending> = if result.is_ok() {
            self.projections.drain(..done_projections).collect()
        } else {
            self.projections.drain(..).collect()
        };
        // A fork or a rewind may have opened a view that needs steps.
        let opens_view = finished.iter().any(|p| {
            p.projection.frames.iter().any(|f| matches!(f.kind, FrameKind::Session { base: Some(_) } | FrameKind::Rewind { .. }))
        });
        for p in finished {
            acks.extend(p.ack);
        }
        if result.is_ok() {
            self.waiting.extend(waiting);
            self.views |= opens_view;
            // Forget the heads nothing waits on.
            let (projections, upserts, waiting) = (&self.projections, &self.upserts, &self.waiting);
            self.heads.retain(|s, _| {
                waiting.contains(s) || upserts.contains_key(s) || projections.iter().any(|p| p.projection.session == *s)
            });
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
) -> rusqlite::Result<(usize, bool)> {
    let need = frame.rows();
    if need > budget && need <= APPEND_ROWS {
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
                crate::message_index::open_view(tx, session, ordinal, base.session.as_str(), base.end_ordinal_exclusive as i64)?;
            }
        }
        FrameKind::Item { iid, turn, form, model, visible, refs: r, prompt, msg } => {
            if let Some(msg) = msg {
                crate::message_index::add_item(tx, session, ordinal, iid, msg)?;
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
                 frame_offset, frame_len, amend_ordinal, superseded_rev)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL)",
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
                len
            ])?;
            refs(r)?;
        }
        FrameKind::Amend { iid, refs: r, msg } => {
            if let Some(msg) = msg {
                crate::message_index::amend(tx, session, iid, ordinal, msg)?;
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
            let mut left = budget.saturating_sub(1);
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
        FrameKind::Compacted { cid, rows } => {
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
                 boundary, superseded_rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
            )?
            .execute(params![session, ordinal, cid, file_no, offset, len, boundary])?;
            // The context restarts here: a new epoch whose totals count from the replacement.
            crate::message_index::add_compaction(tx, session, ordinal, rows)?;
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
    pool: Arc<ReadPool>,
}

/// Cloneable handle on `index/store.sqlite`. The writer thread finishes the queued
/// requests and exits when the last handle is dropped.
#[derive(Clone)]
pub struct SqliteStore {
    shared: Arc<Shared>,
    sender: mpsc::Sender<Command>,
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
    /// The compactions (oldest first) whose replacement kept this message: where its
    /// rewritten copies are. A kept message that lost part of itself shows that part as an
    /// archived row before the compaction's divider (1.4.5 `compactionArchiveProjection`:
    /// the copy before against the copy kept): copy 0 is this row, copy `n` is `kept[n-1]`.
    /// A dropped message (`archived`) is its newest copy, whole.
    pub kept: Vec<KeptCopy>,
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
    /// Opens (creating if empty) the database and starts its writer thread.
    /// Reads run as jobs on `read_lane`.
    pub fn open(thread: SqliteWriterThread, read_lane: InteractiveIo, path: &Path) -> Result<SqliteStore, DbError> {
        let writer = Writer::start(path)?;
        let (sender, rx) = mpsc::channel();
        thread
            .spawn_thread("mixdog-index-writer", move |_| writer.run(rx))
            .map_err(|e| DbError::Write(e.to_string()))?;
        Ok(SqliteStore {
            shared: Arc::new(Shared {
                path: path.to_path_buf(),
                pool: ReadPool::new(path, read_lane),
            }),
            sender,
        })
    }

    fn submit(&self, cmd: Command) -> Result<(), DbError> {
        self.sender.send(cmd).map_err(|_| DbError::Stopped)
    }

    async fn ask(&self, make: impl FnOnce(Ack) -> Command) -> Result<(), DbError> {
        let (ack, rx) = oneshot::channel();
        self.submit(make(ack))?;
        rx.await.map_err(|_| DbError::Stopped)?
    }

    /// Catalog row write, coalesced per session; resolves once committed.
    /// The row is built by `summary::catalog_row` from `head` and the session's projected
    /// message state when it is written.
    pub async fn upsert(&self, head: CatalogHead, dirty: DirtyMark) -> Result<(), DbError> {
        self.ask(|ack| Command::Upsert { head: Box::new(head), dirty, ack: Some(ack) }).await
    }

    /// Catalog row write without a waiter (active-session header changes).
    pub fn upsert_async(&self, head: CatalogHead) -> Result<(), DbError> {
        self.submit(Command::Upsert { head: Box::new(head), dirty: DirtyMark::Keep, ack: None })
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

    /// The UI language changed: placeholder titles refold in maintenance steps.
    pub async fn set_placeholder_labels(&self, labels: PlaceholderLabels) -> Result<(), DbError> {
        self.ask(|ack| Command::Labels { labels, ack }).await
    }

    fn read<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, DbError>> + Send + 'static {
        self.shared.pool.run(f)
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
        self.shared.pool.with(|c| {
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
        self.shared.pool.with(|c| blob_referenced_on(c, digest))
    }

    /// P §9.2 thread-scope lookup: the indexed op of `session` (records not yet projected
    /// are the session actor's to check).
    pub async fn thread_op(&self, session: &str, op_id: &str) -> Result<Option<ThreadOp>, DbError> {
        let (session, op_id) = (session.to_owned(), op_id.to_owned());
        self.read(move |c| {
            Ok(c.prepare_cached(THREAD_OP_SQL)?
            .query_row([&session, &op_id], |r| {
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
        })
        .await
    }

    /// The compaction dividers of the display history whose position lies in ordinals
    /// `[from, to)` (a page's span, `to` exclusive; `u64::MAX` for the newest page), oldest
    /// first. Each live `compacted` frame of the lineage is one divider
    /// (1.4.5's "Conversation compacted" row), shown immediately before the first
    /// displayed row with ordinal ≥ `boundary`. A compaction a rewind or `clear` superseded has none.
    pub async fn dividers(
        &self,
        lineage: Vec<LineageLevel>,
        cut: Option<u64>,
        from: u64,
        to: u64,
    ) -> Result<Vec<Divider>, DbError> {
        self.read(move |c| dividers_on(c, &lineage, cut, from, to)).await
    }

    /// The JSON list row of a session.
    pub async fn summary(&self, session: &str) -> Result<Option<String>, DbError> {
        let session = session.to_owned();
        self.read(move |c| {
            Ok(c.prepare_cached("SELECT summary FROM sessions WHERE id = ?1")?
                .query_row([&session], |r| r.get(0))
                .optional()?)
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

    /// `history_page` inside a job already on the read lane (the open's J2 window read).
    pub fn history_page_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        cursor: Option<PageCursor>,
        limit: usize,
    ) -> Result<(Vec<HistoryRow>, Option<PageCursor>), DbError> {
        self.shared.pool.with(|c| page_on(c, lineage, cut, cursor, limit))
    }
}

/// The production `IndexProjector` of the migration (WP-MIGRATE `index.rs`): projects the
/// verified `sessions` of data dir `data` into a new index database at `db` (absent
/// before the call; closed, without WAL, after it). Each log is read forward from its
/// `session` frame and folded in memory, frames are written in the writer's bounded
/// transactions, and the catalog row (`summary::catalog_row`) is written clean.
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
        heads.push(project_session(&mut conn, &data.join("sessions").join(id), &blobs).map_err(|e| format!("{id}: {e}"))?);
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
    for head in heads {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        upsert(&tx, &head, DirtyMark::Clear, &labels).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "DELETE").map_err(|e| e.to_string())?;
    Ok(())
}

fn project_session(
    conn: &mut Connection,
    dir: &Path,
    blobs: &crate::blobs::BlobStore,
) -> Result<CatalogHead, String> {
    let row_of = |fold: &crate::fold::Fold| CatalogHead::of(fold);
    use crate::fold::Fold;
    use crate::fold::NoIndex;
    use crate::log::ForwardEnd;
    use crate::schema::record::Record;
    let labels = PlaceholderLabels::default();
    let first = crate::log::first_ordinal_unlaned(dir).map_err(|e| e.to_string())?;
    let mut pos = FramePos { ordinal: first, file_no: 0, offset: 0 };
    let mut fold: Option<Fold> = None;
    let mut resolve = |b: &crate::schema::blob::BodyBlob| {
        blobs.read_unlaned(&b.descriptor().digest).map_err(|e| e.to_string())
    };
    loop {
        let read = crate::log::read_forward_unlaned(dir, pos, APPEND_BYTES as u64).map_err(|e| e.to_string())?;
        let mut frames = Vec::with_capacity(read.frames.len());
        for (record, at, frame_len) in &read.frames {
            match fold.as_mut() {
                None => {
                    let Record::Session(s) = record else {
                        return Err("the first frame is not a session frame".into());
                    };
                    let header = crate::fold::resolve_slot(&s.header, &mut resolve)?;
                    let started = Fold::from_session(s, header, *at);
                    let tx = conn.transaction().map_err(|e| e.to_string())?;
                    upsert(&tx, &row_of(&started), DirtyMark::Clear, &labels).map_err(|e| e.to_string())?;
                    tx.commit().map_err(|e| e.to_string())?;
                    fold = Some(started);
                }
                Some(f) => {
                    let effect = f
                        .prepare([record], &NoIndex, &mut resolve)
                        .map_err(|e| e.to_string())?
                        .pop()
                        .expect("one effect");
                    f.apply(effect, *at);
                }
            }
            let f = fold.as_ref().expect("folded");
            let (kind, op) = crate::projection::project(record, &mut resolve)?;
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
        apply_all(conn, &session, &frames).map_err(|e| e.to_string())?;
        match read.next {
            ForwardEnd::More(next) => pos = next,
            ForwardEnd::Done { .. } => break,
            ForwardEnd::Damaged(d) => return Err(format!("damaged at {d:?}")),
        }
    }
    Ok(row_of(&fold.ok_or("empty log")?))
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
            let (used, complete) = apply_frame(&tx, session, &frames[i], APPEND_ROWS - rows)?;
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
    /// The divider precedes the first displayed row with an ordinal at or above this.
    pub boundary: u64,
}

fn dividers_on(
    c: &Connection,
    lineage: &[LineageLevel],
    cut: Option<u64>,
    from: u64,
    to: u64,
) -> Result<Vec<Divider>, DbError> {
    let clamp = |v: u64| v.min(i64::MAX as u64) as i64;
    let mut out = Vec::new();
    for (i, level) in lineage.iter().enumerate() {
        let asof = level.end.map_or(i64::MAX, clamp);
        let bound = if i > 0 { level.end.into_iter().chain(cut).min().map_or(i64::MAX, clamp) } else { i64::MAX };
        let mut stmt = c.prepare_cached(
            "SELECT ordinal, file_no, frame_offset, frame_len, cid, boundary FROM compactions
             WHERE session = ?1 AND ordinal < ?5 AND (superseded_rev IS NULL OR superseded_rev >= ?2)
               AND boundary >= ?3 AND boundary < ?4",
        )?;
        let rows = stmt.query_map(params![level.session, asof, clamp(from), clamp(to), bound], |r| {
            let ordinal = r.get::<_, i64>(0)? as u64;
            Ok(Divider {
                session: level.session.clone(),
                cid: r.get(4)?,
                pos: FramePos { ordinal, file_no: r.get(1)?, offset: r.get::<_, i64>(2)? as u64 },
                frame_len: r.get::<_, i64>(3)? as u64,
                boundary: r.get::<_, i64>(5)? as u64,
            })
        })?;
        for row in rows {
            out.push(row?);
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
                    let archived: bool = r.get(12)?;
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
                        archived,
                        kept,
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

/// One history page level: visible rows below `?2`, live for the reader at `?3`.
pub(crate) const PAGE_SQL: &str =
    "SELECT h.ordinal, h.iid, h.turn, h.form, h.model, h.file_no, h.frame_offset, h.frame_len,
       a.ordinal, a.file_no, a.frame_offset, a.frame_len,
       (h.model = 1 AND h.form = 0 AND h.ordinal < COALESCE((SELECT max(c.ordinal) FROM compactions c
          WHERE c.session = h.session AND c.ordinal < ?3 AND (c.superseded_rev IS NULL OR c.superseded_rev >= ?3)), 0)
        AND NOT EXISTS (SELECT 1 FROM message_rows m WHERE m.session = h.session AND m.iid = h.iid
          AND m.ordinal = (SELECT max(c.ordinal) FROM compactions c WHERE c.session = h.session AND c.ordinal < ?3
            AND (c.superseded_rev IS NULL OR c.superseded_rev >= ?3))
          AND (m.superseded_rev IS NULL OR m.superseded_rev >= ?3)))
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
}

impl ReadPool {
    pub(crate) fn new(path: &Path, lane: InteractiveIo) -> Arc<ReadPool> {
        Arc::new(ReadPool {
            path: path.to_path_buf(),
            lane,
            conns: Mutex::new(Vec::new()),
        })
    }

    pub(crate) fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T, DbError>) -> Result<T, DbError> {
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
        let pool = self.clone();
        let job = self
            .lane
            .submit(&CancellationToken::new(), move |_| pool.with(f))
            .map_err(|_| DbError::LaneFull);
        async move { job?.await.map_err(|_| DbError::Stopped)? }
    }
}

impl LineageIndex for SqliteStore {
    fn live_rows(&self, session: &str, from: u64, to: u64) -> Result<(u64, u64), LookupError> {
        self.shared.pool.with(|c| {
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
        self.shared.pool.with(|c| {
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
