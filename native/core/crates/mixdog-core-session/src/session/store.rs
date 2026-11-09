//! The session seams over `mixdog-store` (WP-STORE): the record codec, the `LogWriter` as
//! [`SessionLog`], and the thread open/create paths over the session logs, the blob store and
//! the index.
//!
//! Open: J1 is the bounded log open (`log::open_log`: reverse scan, tail parse and fold); J2
//! reads the UI window (`history_page_on_lane` + positioned frame reads), the open-set
//! records and the prompt-history prefill; decode assembles the session's [`OpenedLog`]. The
//! store's fold already covers the tail, so the opened log carries no tail records.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::MAX_BLOB_BYTES;
use mixdog_rt::CpuInteractive;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::MaintenanceIo;
use mixdog_core_api::ids::ItemId;
use mixdog_store::blobs::BlobStore;
use mixdog_store::context::ContextBlobs;
use mixdog_store::context::ContextCursor;
use mixdog_store::context::ContextError;
use mixdog_store::context::ContextPage;
use mixdog_store::context::DecodedContext;
use mixdog_store::context::decode_context;
use mixdog_store::context::finish_context;
use mixdog_store::context::read_context_blobs;
use mixdog_store::sqlite::DbError;
use mixdog_store::encode::EncodeError;
use mixdog_store::encode::Encoded;
use mixdog_store::encode::encode_record;
use mixdog_store::fsio::IoLane;
use mixdog_store::fold::Fold;
use mixdog_store::log;
use mixdog_store::log::AppendError;
use mixdog_store::log::LogWriter;
use mixdog_store::log::OpenAppendError;
use mixdog_store::log::OpenError;
use mixdog_store::log::Outcome;
use mixdog_store::log::ReadError;
use mixdog_store::log::WriterDeps;
use mixdog_store::projection::Projection;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::checkpoint::FramePos;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::ItemRecord;
use mixdog_store::schema::record::Record;
use mixdog_store::sqlite::DirtyMark;
use mixdog_store::sqlite::HistoryRow;
use mixdog_store::sqlite::LineageLevel;
use mixdog_store::sqlite::SqliteStore;
use mixdog_store::summary::CatalogHead;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::mpsc;

use super::seams::AppendPosition;
use super::seams::BarrierError;
use super::seams::CommitRecord;
use super::seams::ContextRead;
use super::seams::ContextStep;
use super::seams::EncodedRecord;
use super::seams::HeadRead;
use super::seams::OpenedLog;
use super::seams::RecordCodec;
use super::seams::SessionLog;
use super::seams::StoredOp;
use super::seams::ThreadStore;
use super::seams::WindowRead;

/// UI window rows read at open (P §5.3).
const WINDOW_ROWS: usize = 200;
/// Fork depth followed for the lineage; a deeper chain is a damaged catalog.
const MAX_LINEAGE: usize = 64;

/// [`RecordCodec`] = `encode_record` (FORMAT.md §5.1 with the §4.2 body-slot rule).
pub struct StoreCodec;

impl RecordCodec for StoreCodec {
    fn encode(
        &self,
        _lane: &InLane<CpuInteractive>,
        record: &Record,
    ) -> Result<EncodedRecord, CoreError> {
        encode_record(record.clone())
            .map(EncodedRecord)
            .map_err(|error| match error {
                EncodeError::ItemTooLarge { .. } => CoreError::ItemTooLarge {
                    limit: MAX_BLOB_BYTES,
                },
                other => internal("encode", &other),
            })
    }
}

fn internal(step: &str, error: &dyn std::fmt::Display) -> CoreError {
    CoreError::Internal {
        incident_id: format!("session-store-{step}: {error}").into(),
    }
}

/// Forwards every barrier's projection to the index writer in barrier order; the blob store
/// keeps the batch's pins until the projection is committed.
#[derive(Clone)]
pub struct Projector(mpsc::UnboundedSender<Projecting>);

enum Projecting {
    Frames(Box<Projection>),
    /// Answered once every projection sent before it is committed.
    Flush(tokio::sync::oneshot::Sender<()>),
}

impl Projector {
    /// Starts the forwarding task on the current Tokio runtime.
    pub fn spawn(index: SqliteStore) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Projecting>();
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                match msg {
                    // A failed projection leaves the session dirty; reconcile re-projects it.
                    Projecting::Frames(projection) => drop(index.project(*projection).await),
                    Projecting::Flush(done) => drop(done.send(())),
                }
            }
        });
        Self(tx)
    }

    fn send(&self, projection: Projection) {
        let _ = self.0.send(Projecting::Frames(Box::new(projection)));
    }

    /// Waits until the index holds every barrier acked so far.
    async fn flush(&self) {
        let (done, wait) = tokio::sync::oneshot::channel();
        if self.0.send(Projecting::Flush(done)).is_ok() {
            let _ = wait.await;
        }
    }
}

/// `AppendError::outcome()`: `NotApplied` → `Failed`, `Unknown` → `Indeterminate`.
fn barrier(error: AppendError) -> BarrierError {
    let io_kind: Arc<str> = error.io_kind().into();
    match error.outcome() {
        Outcome::NotApplied => BarrierError::Failed { io_kind },
        Outcome::Unknown => BarrierError::Indeterminate { io_kind },
    }
}

/// [`SessionLog`] over a `LogWriter` (which places checkpoints and rotates by itself).
struct StoreLog {
    writer: LogWriter,
    projector: Projector,
}

impl SessionLog for StoreLog {
    fn commit(
        &mut self,
        lane: &InLane<DurabilityIo>,
        batch: &[CommitRecord],
    ) -> Result<Vec<u64>, BarrierError> {
        let encoded: Vec<Encoded> = batch.iter().map(|c| c.encoded.0.clone()).collect();
        let ack = self.writer.append_barrier(lane, encoded).map_err(barrier)?;
        let ordinals = ack.positions.iter().map(|p| p.ordinal).collect();
        self.projector.send(ack.projection);
        Ok(ordinals)
    }

    fn retry(&mut self, lane: &InLane<DurabilityIo>) -> Result<(), BarrierError> {
        self.writer.retry_storage(lane).map_err(barrier)
    }
}

/// [`ThreadStore`] over `<data>/sessions/<id>`, the blob store and the index.
pub struct StoreThreads {
    data: PathBuf,
    sessions: PathBuf,
    blobs: BlobStore,
    index: SqliteStore,
    writer: WriterDeps,
    projector: Projector,
    maintenance: MaintenanceIo,
    runtime: tokio::runtime::Handle,
}

impl StoreThreads {
    /// `data` is the data dir; `writer.blobs`/`writer.index` are the same stores; `maintenance`
    /// runs the purge after each delete. Call on the Tokio runtime the catalog writes and
    /// projections run on.
    pub fn new(data: &Path, blobs: BlobStore, index: SqliteStore, writer: WriterDeps, maintenance: MaintenanceIo) -> Self {
        Self {
            data: data.to_path_buf(),
            sessions: data.join("sessions"),
            blobs,
            projector: Projector::spawn(index.clone()),
            index,
            writer,
            maintenance,
            runtime: tokio::runtime::Handle::current(),
        }
    }

    /// Over the data dir's stores: `index` is the core's one `SqliteStore` (WP-STORE opens it,
    /// with its boot purge), `ownership` the core's data-dir lock every log writer revalidates;
    /// the blob store and the log writers are the data dir's own. `<data>/sessions` is made on
    /// the maintenance lane first. Call on the Tokio runtime the projections run on.
    pub async fn over_data_dir(
        data: &Path,
        index: SqliteStore,
        ownership: Arc<dyn mixdog_core_api::domain::ownership::Ownership>,
        maintenance: MaintenanceIo,
    ) -> Result<Self, CoreError> {
        let sessions = data.join("sessions");
        mixdog_rt::LaneToken::submit(maintenance, &mixdog_rt::CancellationToken::new(), move |_lane| {
            mixdog_store::fsio::create_dir_durable(&sessions)
        })
        .map_err(|_| internal("sessions-dir", &"maintenance lane refused"))?
        .await
        .map_err(|_| internal("sessions-dir", &"maintenance job dropped"))?
        .map_err(|e| internal("sessions-dir", &e))?;
        let blobs = BlobStore::new(data);
        let writer = WriterDeps {
            io: Arc::new(mixdog_store::log::OsIo),
            blobs: blobs.clone(),
            ownership,
            index: Arc::new(index.clone()),
        };
        Ok(Self::new(data, blobs, index, writer, maintenance))
    }

    /// An index write from inside a lane job (`_lane` is the proof). Lane threads are not runtime
    /// threads; an inline lane (tests) runs on a runtime worker, which must hand off its tasks
    /// first.
    #[allow(clippy::disallowed_methods, reason = "runs inside a lane job (lane proof argument)")]
    fn wait<L, F: std::future::Future>(&self, _lane: &InLane<L>, future: F) -> F::Output {
        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::task::block_in_place(|| self.runtime.block_on(future))
        } else {
            self.runtime.block_on(future)
        }
    }

    fn dir(&self, session: &str) -> PathBuf {
        self.sessions.join(session)
    }

    /// `<data>/sessions`: one folder per stored session.
    pub(crate) fn sessions_dir(&self) -> &Path {
        &self.sessions
    }

    /// The core's index the thread store projects into.
    pub(crate) fn index(&self) -> &SqliteStore {
        &self.index
    }

    /// Returns once the index holds every write acked so far (the projection runs behind the ack).
    #[cfg(test)]
    pub(crate) async fn projected(&self) {
        self.projector.flush().await;
    }

    fn not_found(id: &ThreadId) -> CoreError {
        CoreError::ThreadNotFound {
            thread_id: id.clone(),
        }
    }

    fn open_error(id: &ThreadId, error: OpenError) -> CoreError {
        match error {
            OpenError::Missing(_) => Self::not_found(id),
            OpenError::Io(e) if e.source.kind() == std::io::ErrorKind::NotFound => {
                Self::not_found(id)
            }
            other => internal("open", &other),
        }
    }

    /// The bounded open of a thread's log; `threadNotFound` for an unknown or deleted thread
    /// (its header's delete mark). A fork still reads a deleted base's logs: `lineage` opens
    /// them directly.
    fn open(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<log::OpenedLog, CoreError> {
        let opened = log::open_log(lane, &self.dir(id.as_str()), &self.blobs, &self.index)
            .map_err(|e| Self::open_error(id, e))?;
        if mixdog_store::summary::is_deleted(&opened.fold.header) {
            return Err(Self::not_found(id));
        }
        Ok(opened)
    }

    fn read_error(id: &ThreadId, error: ReadError) -> CoreError {
        match error {
            ReadError::Damaged(d) => CoreError::StoreDamaged {
                thread_id: id.clone(),
                file_no: u64::from(d.file_no),
                offset: d.offset,
            },
            ReadError::Io(e) => internal("read", &e),
        }
    }

    /// An out-of-line slot read back from the blob store.
    fn resolve<T: DeserializeOwned + Clone, L: IoLane>(
        &self,
        lane: &InLane<L>,
        slot: &Slot<T>,
    ) -> Result<Slot<T>, CoreError> {
        match slot {
            Slot::Inline(_) => Ok(slot.clone()),
            Slot::Blob(blob) => {
                let bytes = self
                    .blobs
                    .read(lane, &blob.descriptor().digest)
                    .map_err(|e| internal("blob", &e))?;
                serde_json::from_slice(&bytes)
                    .map(Slot::Inline)
                    .map_err(|e| internal("blob", &e))
            }
        }
    }

    /// `[session, base, base's base, …]` with each base's fork point (FORMAT.md §5.3).
    fn lineage(
        &self,
        lane: &InLane<InteractiveIo>,
        fold: &Fold,
    ) -> Result<Vec<LineageLevel>, CoreError> {
        let mut levels = vec![LineageLevel {
            session: fold.session.clone(),
            end: None,
        }];
        let mut base = fold.base.clone();
        while let Some(level) = base {
            if levels.len() >= MAX_LINEAGE {
                return Err(internal("lineage", &"fork chain too deep"));
            }
            let dir = self.dir(level.session.as_str());
            let head = log::read_head(lane, &dir).map_err(|e| internal("lineage", &e))?;
            let tail = log::read_tail(lane, head, &self.blobs, &self.index)
                .map_err(|e| internal("lineage", &e))?;
            base = tail.anchor_fold().base.clone();
            levels.push(LineageLevel {
                session: level.session.as_str().to_owned(),
                end: Some(level.end_ordinal_exclusive),
            });
        }
        Ok(levels)
    }

    fn frame_at(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        dir: &Path,
        pos: FramePos,
    ) -> Result<Record, CoreError> {
        log::read_frame_at(lane, dir, pos).map_err(|e| Self::read_error(id, e))
    }

    /// The item record of one history row: its frame, its latest amend's body, and both
    /// out-of-line slots read back.
    fn history_item(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        row: &HistoryRow,
    ) -> Result<ItemRecord, CoreError> {
        let dir = self.dir(&row.session);
        let Record::Item(mut item) =
            log::read_frame(lane, &dir, row.pos, row.frame_len).map_err(|e| Self::read_error(id, e))?
        else {
            return Err(unexpected("item"));
        };
        if let Some((pos, len)) = row.amend {
            let Record::Amend(amend) = log::read_frame(lane, &dir, pos, len).map_err(|e| Self::read_error(id, e))?
            else {
                return Err(unexpected("amend"));
            };
            item.body = amend.body;
        }
        item.body = self.resolve(lane, &item.body)?;
        item.prompt = item.prompt.map(|prompt| self.resolve(lane, &prompt)).transpose()?;
        super::transcript::fold_model_switches(&mut item, &row.model_switches);
        Ok(item)
    }

    /// The compaction dividers among the window's rows `rows` (newest first, as paged), each
    /// with the window index it precedes. A divider of `lineage[level]` goes before that
    /// level's first shown row at or above its boundary, else after the level's rows; the
    /// window runs deepest level first, so that index counts the rows of deeper levels and this
    /// level's rows below the boundary. With older rows unread, the oldest shown row bounds its
    /// level and deeper levels show none.
    fn window_dividers(
        &self,
        lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        rows: &[HistoryRow],
        has_older: bool,
    ) -> Result<Vec<super::seams::WindowDivider>, CoreError> {
        let level_of = |row: &HistoryRow| lineage.iter().position(|level| level.session == row.session);
        let shown: Vec<(usize, u64)> = rows.iter().filter_map(|row| level_of(row).map(|level| (level, row.ordinal))).collect();
        let (deepest, from) = match rows.last().and_then(|row| level_of(row).map(|level| (level, row.ordinal))) {
            Some((level, ordinal)) if has_older => (level, ordinal),
            _ => (lineage.len().saturating_sub(1), 0),
        };
        let mut out = Vec::new();
        for level in (0..=deepest).rev() {
            let from = if level == deepest { from } else { 0 };
            let found = self
                .wait(lane, self.index.dividers(lineage.to_vec(), cut, level, from, u64::MAX))
                .map_err(|e| internal("dividers", &e))?;
            for divider in found {
                let before = shown
                    .iter()
                    .filter(|(shown, ordinal)| *shown > level || (*shown == level && *ordinal < divider.boundary))
                    .count();
                out.push(super::seams::WindowDivider {
                    before,
                    ordinal: divider.pos.ordinal,
                    cid: divider.cid,
                    at: divider.at,
                    model_switches: divider.model_switches,
                });
            }
        }
        // Stable: at one place, a deeper level's dividers first, each level's in boundary order.
        out.sort_by_key(|divider| divider.before);
        Ok(out)
    }
}

/// Context rows read per page.
const CONTEXT_PAGE_ROWS: usize = 200;

/// A model-context read between its lane steps.
struct ContextState {
    lineage: Vec<LineageLevel>,
    cut: Option<u64>,
    out: Vec<(ItemId, Value)>,
    at: ContextAt,
}

enum ContextAt {
    /// The next page is read from this cursor (io).
    Next(ContextCursor),
    /// A page to decode (cpu).
    Page(ContextPage),
    /// A decoded page whose blobs are read next (io).
    Decoded(DecodedContext),
    /// A decoded page and its blobs, to finish (cpu).
    Finish(DecodedContext, ContextBlobs),
    /// Between a page's finish and its successor.
    Pending,
}

impl StoreThreads {
    /// The first page of the read, over the lineage as of now.
    fn context_start(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
    ) -> Result<ContextState, CoreError> {
        let opened = self.open(lane, id)?;
        let lineage = self.lineage(lane, &opened.fold)?;
        let cut = opened.fold.base_cut;
        let page = self
            .index
            .context_page_on_lane(lane, &self.sessions, &lineage, cut, None, CONTEXT_PAGE_ROWS)
            .map_err(|e| internal("context", &e))?;
        Ok(ContextState {
            lineage,
            cut,
            out: Vec::new(),
            at: ContextAt::Page(page),
        })
    }

    /// The cpu end of a page: its messages, then the next page or the whole context.
    fn context_finish(
        lane: &InLane<CpuInteractive>,
        mut state: ContextState,
        decoded: DecodedContext,
        blobs: ContextBlobs,
    ) -> Result<ContextStep, CoreError> {
        let next = decoded.next;
        state.out.extend(
            finish_context(lane, decoded, blobs)
                .map_err(|e| internal("context", &e))?
                .into_iter()
                .map(|m| (ItemId::from(m.iid), m.body)),
        );
        Ok(match next {
            Some(cursor) => {
                state.at = ContextAt::Next(cursor);
                ContextStep::More(ContextRead(Box::new(state)))
            }
            None => ContextStep::Done(state.out),
        })
    }
}

/// [`super::seams::TurnIngest`] over the session-search writer.
pub struct SessionSearchTurns(pub Arc<mixdog_services::memory::session_search::ingest::SessionSearchIngest>);

impl SessionSearchTurns {
    /// Over the memory service's one session-search writer (`SessionSearchIngest::new(db,
    /// sensitive)`, the same one `forgetSessionSearch` and the backfill use).
    pub fn new(ingest: Arc<mixdog_services::memory::session_search::ingest::SessionSearchIngest>) -> Self {
        Self(ingest)
    }
}

/// What the session-search writer takes of a session: its model context, and
/// `isAgentOnlySession` (store-summary-visibility.mjs) of the session record. Node's record is
/// the header with its `id` (`{ ...header, id }`); a stored header carries no `id`, and a root
/// Lead is recognized by its owner link naming that id.
pub(crate) fn search_session(
    id: &ThreadId,
    header: &mixdog_store::schema::record::Header,
    messages: Vec<Value>,
) -> mixdog_services::memory::session_search::ingest::IngestSession {
    let mut session = header.clone();
    session.insert("id".into(), Value::String(id.as_str().to_owned()));
    mixdog_services::memory::session_search::ingest::IngestSession {
        id: id.as_str().to_owned(),
        messages,
        agent_only: mixdog_store::summary::session_visibility(&session) == "agent-only",
    }
}

impl super::seams::TurnIngest for SessionSearchTurns {
    fn ingest_turn(&self, id: &ThreadId, header: &mixdog_store::schema::record::Header, messages: Vec<Value>) {
        self.0.ingest_turn(search_session(id, header, messages));
    }
}

/// [`super::seams::SensitiveMarks`] over the process's sensitive-value store.
pub struct SensitiveMarksOf(pub Arc<mixdog_services::memory::sensitive::SensitiveStore>);

impl super::seams::SensitiveMarks for SensitiveMarksOf {
    fn on_marked(&self, thread: &ThreadId, listener: Box<dyn Fn() + Send + Sync>) -> Box<dyn Send> {
        Box::new(self.0.on_marked(thread.as_str(), move |_| listener()))
    }
}

/// [`super::seams::CloseIngest`] over the memory module's `ingest_session` action; `None` when
/// memory was not started this run (today's `getMemoryModPromise()` returning null).
pub struct MemoryCloseIngest(pub Option<Arc<dyn mixdog_services::memory::service::MemoryModule>>);

impl MemoryCloseIngest {
    /// Over the memory module the daemon started (`LocalMemory`), or `None` when memory is off.
    pub fn new(memory: Option<Arc<dyn mixdog_services::memory::service::MemoryModule>>) -> Self {
        Self(memory)
    }
}

impl super::seams::CloseIngest for MemoryCloseIngest {
    fn ingest(&self, id: &ThreadId, cwd: &str, messages: Vec<Value>) -> futures::future::BoxFuture<'static, ()> {
        let Some(memory) = self.0.clone() else {
            return Box::pin(async {});
        };
        if std::env::var("MIXDOG_DISABLE_MEMORY_INGEST").as_deref() == Ok("1") || messages.is_empty() {
            return Box::pin(async {});
        }
        // `session.cwd || getCurrentCwd()`.
        let cwd = if cwd.is_empty() {
            std::env::current_dir().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default()
        } else {
            cwd.to_owned()
        };
        let args = serde_json::json!({
            "action": "ingest_session",
            "sessionId": id.as_str(),
            "cwd": cwd,
            "messages": messages,
        });
        Box::pin(async move {
            memory.memory(args).await;
        })
    }
}

/// J2's reads, handed to decode.
struct Window {
    window: Vec<(u64, ItemRecord)>,
    dividers: Vec<super::seams::WindowDivider>,
    has_older: bool,
    prompts: Vec<String>,
    runs: Vec<(u64, mixdog_store::schema::record::RunRecord)>,
    approvals: Vec<(u64, mixdog_store::schema::record::ApprovalRecord)>,
    queue: Vec<(u64, mixdog_store::schema::record::QueueRecord)>,
}

fn unexpected(what: &str) -> CoreError {
    internal("open-set", &format!("frame is not a {what} record"))
}

impl ThreadStore for StoreThreads {
    #[allow(clippy::disallowed_methods, reason = "runs inside an interactive-io lane job (lane proof argument)")]
    fn read_head(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
    ) -> Result<HeadRead, CoreError> {
        if !self.dir(id.as_str()).is_dir() {
            return Err(Self::not_found(id));
        }
        Ok(HeadRead(Box::new(self.open(lane, id)?)))
    }

    #[allow(clippy::disallowed_methods, reason = "runs inside an interactive-io lane job (lane proof argument)")]
    fn read_header(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Header, CoreError> {
        if !self.dir(id.as_str()).is_dir() {
            return Err(Self::not_found(id));
        }
        Ok(self.open(lane, id)?.fold.header.clone())
    }

    fn read_log_id(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<String, CoreError> {
        Ok(self.open(lane, id)?.fold.log_id.clone())
    }

    fn read_window(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        head: &HeadRead,
    ) -> Result<WindowRead, CoreError> {
        // The window comes from the index: it must hold every barrier acked so far (a thread
        // unloaded and reopened in this process).
        self.wait(lane, self.projector.flush());
        let opened = head
            .0
            .downcast_ref::<log::OpenedLog>()
            .expect("StoreThreads head");
        let fold = &opened.fold;
        let lineage = self.lineage(lane, fold)?;
        let (rows, cursor) = self
            .index
            .history_page_on_lane(lane, &lineage, fold.base_cut, None, WINDOW_ROWS)
            .map_err(|e| internal("window", &e))?;
        let mut window = Vec::with_capacity(rows.len());
        for row in rows.iter().rev() {
            window.push((row.ordinal, self.history_item(lane, id, row)?));
        }
        let dividers = self.window_dividers(lane, &lineage, fold.base_cut, &rows, cursor.is_some())?;
        let prompts = self
            .index
            .prompts_on_lane(lane, &lineage, fold.base_cut)
            .map_err(|e| internal("prompts", &e))?;
        let dir = &opened.dir;
        let mut runs = Vec::new();
        for run in &fold.runs {
            let Record::Run(mut record) = self.frame_at(lane, id, dir, run.started)? else {
                return Err(unexpected("run"));
            };
            if let Some(detail) = &record.detail {
                record.detail = Some(self.resolve(lane, detail)?);
            }
            runs.push((run.started.ordinal, record));
        }
        let mut approvals = Vec::new();
        for approval in &fold.approvals {
            let Record::Approval(mut record) = self.frame_at(lane, id, dir, approval.requested)?
            else {
                return Err(unexpected("approval"));
            };
            if let Some(body) = &record.body {
                record.body = Some(self.resolve(lane, body)?);
            }
            approvals.push((approval.requested.ordinal, record));
        }
        let mut queue = Vec::new();
        for entry in &fold.queue {
            let Record::Queue(mut record) = self.frame_at(lane, id, dir, entry.current())? else {
                return Err(unexpected("queue"));
            };
            // The window holds the entry as it stands, queued once at its place.
            record.action = mixdog_store::schema::record::QueueAction::Enqueue;
            if let Some(slot) = &record.entry {
                record.entry = Some(self.resolve(lane, slot)?);
            }
            queue.push((entry.enqueued.ordinal, record));
        }
        Ok(WindowRead(Box::new(Window {
            window,
            dividers,
            has_older: cursor.is_some(),
            prompts,
            runs,
            approvals,
            queue,
        })))
    }

    fn decode(
        &self,
        _lane: &InLane<CpuInteractive>,
        _id: &ThreadId,
        head: HeadRead,
        window: WindowRead,
    ) -> Result<OpenedLog, CoreError> {
        let opened = *head.0.downcast::<log::OpenedLog>().expect("StoreThreads head");
        let read = *window.0.downcast::<Window>().expect("StoreThreads window");
        let fold = &opened.fold;
        // `thread/clear` rewinds to the lineage's first row: a fork may cut into its base.
        let lineage_start = if fold.base.is_some() {
            0
        } else {
            fold.start_ordinal + 1
        };
        Ok(OpenedLog {
            header: fold.header.clone(),
            control: fold.control,
            history_rev: fold.history_rev,
            lineage_start,
            runs: read.runs,
            approvals: read.approvals,
            queue: read.queue,
            window: read.window,
            dividers: read.dividers,
            has_older: read.has_older,
            prompts: read.prompts,
            log_id: fold.log_id.clone(),
            next_ordinal: fold.next_ordinal,
            tail: Vec::new(),
            append: AppendPosition(Box::new(opened)),
        })
    }

    /// The whole lineage's prompt rows, as the index keeps them (newest 50, deduped), once the
    /// index holds the history mutation that asked for them.
    fn user_rows(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
    ) -> Result<Vec<ItemRecord>, CoreError> {
        self.wait(lane, self.projector.flush());
        let opened = self.open(lane, id)?;
        let lineage = self.lineage(lane, &opened.fold)?;
        let prompts = self
            .index
            .prompts_on_lane(lane, &lineage, opened.fold.base_cut)
            .map_err(|e| internal("prompts", &e))?;
        // Oldest first, as the seam returns rows; only `prompt` is read by the caller.
        Ok(prompts.into_iter().rev().map(prompt_row).collect())
    }

    /// Every page of the lineage's history, as acked so far; a page after a rewind restarts
    /// the read over the new history.
    fn history_rows(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
    ) -> Result<(u64, Vec<ItemRecord>), CoreError> {
        self.wait(lane, self.projector.flush());
        'read: loop {
            let opened = self.open(lane, id)?;
            let lineage = self.lineage(lane, &opened.fold)?;
            let (mut rows, mut cursor) = (Vec::new(), None);
            loop {
                let (page, next) = match self.index.history_page_on_lane(lane, &lineage, opened.fold.base_cut, cursor, WINDOW_ROWS) {
                    Ok(page) => page,
                    Err(DbError::CursorStale) => continue 'read,
                    Err(e) => return Err(internal("history", &e)),
                };
                for row in &page {
                    rows.push(self.history_item(lane, id, row)?);
                }
                match next {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            // Pages run newest first; the seam returns rows oldest first.
            rows.reverse();
            return Ok((opened.fold.history_rev, rows));
        }
    }

    fn thread_op(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, op: &str) -> Result<Option<StoredOp>, CoreError> {
        self.wait(lane, self.projector.flush());
        let Some(row) = self.wait(lane, self.index.thread_op(id.as_str(), op)).map_err(|e| internal("thread-op", &e))? else {
            return Ok(None);
        };
        let record =
            log::read_frame(lane, &self.dir(id.as_str()), row.pos, row.frame_len).map_err(|e| Self::read_error(id, e))?;
        let result = super::thread_ops::op_ref_of(&record).and_then(|o| o.result.as_ref()).map(|r| r.get().clone());
        let detail = match &record {
            Record::Op(r) => match &r.detail {
                Some(slot) => match self.resolve(lane, slot)? {
                    Slot::Inline(value) => Some(value),
                    Slot::Blob(_) => return Err(internal("thread-op", &"detail left out of line")),
                },
                None => None,
            },
            _ => None,
        };
        Ok(Some(StoredOp { method: row.method, digest: row.payload_digest, state: row.state, seq: row.pos.ordinal, result, detail }))
    }

    fn fenced_ops(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Vec<String>, CoreError> {
        self.wait(lane, self.projector.flush());
        self.wait(lane, self.index.fenced_ops(id.as_str())).map_err(|e| internal("fenced-ops", &e))
    }

    /// Pages newest first until the row is found: a switch anchors near the history's end.
    fn history_row(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        iid: &str,
    ) -> Result<Option<(u64, ItemRecord)>, CoreError> {
        self.wait(lane, self.projector.flush());
        'read: loop {
            let opened = self.open(lane, id)?;
            let lineage = self.lineage(lane, &opened.fold)?;
            let mut cursor = None;
            loop {
                let (page, next) = match self.index.history_page_on_lane(lane, &lineage, opened.fold.base_cut, cursor, WINDOW_ROWS) {
                    Ok(page) => page,
                    Err(DbError::CursorStale) => continue 'read,
                    Err(e) => return Err(internal("history", &e)),
                };
                if let Some(row) = page.iter().find(|row| row.iid == iid) {
                    return Ok(Some((row.ordinal, self.history_item(lane, id, row)?)));
                }
                match next {
                    Some(next) => cursor = Some(next),
                    None => return Ok(None),
                }
            }
        }
    }

    fn compaction_entry(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        iid: &str,
    ) -> Result<Option<mixdog_store::sqlite::CompactionEntry>, CoreError> {
        self.wait(lane, self.projector.flush());
        let opened = self.open(lane, id)?;
        let lineage = self.lineage(lane, &opened.fold)?;
        self.index
            .compaction_entry_on_lane(lane, &lineage, opened.fold.base_cut, iid)
            .map_err(|e| internal("history", &e))
    }

    fn session_meta(
        &self,
        id: &ThreadId,
    ) -> futures::future::BoxFuture<'static, Result<Option<super::seams::SessionMeta>, CoreError>> {
        let (index, id) = (self.index.clone(), id.as_str().to_owned());
        Box::pin(async move {
            let Some(summary) = index.summary(&id).await.map_err(|e| internal("meta", &e))? else {
                return Ok(None);
            };
            let title = index.title(&id).await.map_err(|e| internal("meta", &e))?;
            Ok(Some(super::seams::SessionMeta::of(title, &summary)))
        })
    }

    fn purge_deleted(&self) -> futures::future::BoxFuture<'static, Result<Vec<String>, CoreError>> {
        let (projector, index, lane, data) = (self.projector.clone(), self.index.clone(), self.maintenance, self.data.clone());
        Box::pin(async move {
            projector.flush().await;
            index.purge_deleted(lane, data).await.map_err(|e| internal("purge", &e))
        })
    }

    /// Pages run while the cursor holds; a page after a rewind or compaction restarts the
    /// read over the new lineage.
    fn context_io(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        read: Option<ContextRead>,
    ) -> Result<ContextRead, CoreError> {
        let Some(read) = read else {
            // The read must see every row acked so far.
            self.wait(lane, self.projector.flush());
            return Ok(ContextRead(Box::new(self.context_start(lane, id)?)));
        };
        let mut state = *read.0.downcast::<ContextState>().expect("StoreThreads context");
        state.at = match state.at {
            ContextAt::Next(cursor) => match self.index.context_page_on_lane(
                lane,
                &self.sessions,
                &state.lineage,
                state.cut,
                Some(cursor),
                CONTEXT_PAGE_ROWS,
            ) {
                Ok(page) => ContextAt::Page(page),
                Err(ContextError::Db(DbError::CursorStale)) => {
                    return Ok(ContextRead(Box::new(self.context_start(lane, id)?)));
                }
                Err(e) => return Err(internal("context", &e)),
            },
            ContextAt::Decoded(decoded) => {
                let blobs = read_context_blobs(lane, &self.blobs, &decoded)
                    .map_err(|e| internal("context", &e))?;
                ContextAt::Finish(decoded, blobs)
            }
            ContextAt::Page(_) | ContextAt::Finish(..) | ContextAt::Pending => {
                return Err(internal("context", &"io step on a cpu state"));
            }
        };
        Ok(ContextRead(Box::new(state)))
    }

    fn context_cpu(
        &self,
        lane: &InLane<CpuInteractive>,
        read: ContextRead,
    ) -> Result<ContextStep, CoreError> {
        let state = *read.0.downcast::<ContextState>().expect("StoreThreads context");
        let ContextState { lineage, cut, out, at } = state;
        let rest = |at| ContextState { lineage, cut, out, at };
        match at {
            ContextAt::Page(page) => {
                let decoded = decode_context(lane, page).map_err(|e| internal("context", &e))?;
                if decoded.needs_blobs() {
                    let state = rest(ContextAt::Decoded(decoded));
                    return Ok(ContextStep::More(ContextRead(Box::new(state))));
                }
                let (state, blobs) = (rest(ContextAt::Pending), ContextBlobs::default());
                Self::context_finish(lane, state, decoded, blobs)
            }
            ContextAt::Finish(decoded, blobs) => {
                Self::context_finish(lane, rest(ContextAt::Pending), decoded, blobs)
            }
            ContextAt::Next(_) | ContextAt::Decoded(_) | ContextAt::Pending => {
                Err(internal("context", &"cpu step on an io state"))
            }
        }
    }

    /// RL §9.2 rule 1: the session is marked dirty before the activation's first append.
    fn open_log(
        &self,
        lane: &InLane<DurabilityIo>,
        id: &ThreadId,
        at: AppendPosition,
    ) -> Result<Box<dyn SessionLog>, BarrierError> {
        let opened = *at.0.downcast::<log::OpenedLog>().expect("StoreThreads position");
        self.wait(lane, self.index.mark_dirty(id.as_str()))
            .map_err(|e| BarrierError::Failed {
                io_kind: format!("index:{e}").into(),
            })?;
        let writer = LogWriter::open(lane, opened, self.writer.clone()).map_err(|e| match e {
            OpenAppendError::StoreDamaged(_) => BarrierError::Failed {
                io_kind: "storeDamaged".into(),
            },
            OpenAppendError::Io(e) => BarrierError::Failed {
                io_kind: e.op.to_string().into(),
            },
        })?;
        Ok(Box::new(StoreLog {
            writer,
            projector: self.projector.clone(),
        }))
    }

    /// RL §9.2 rule 4: the catalog row (dirty) is committed before `log.000000` is published.
    fn create_log(
        &self,
        lane: &InLane<DurabilityIo>,
        id: &ThreadId,
        session: &CommitRecord,
    ) -> Result<(Box<dyn SessionLog>, u64), BarrierError> {
        let failed = |kind: &str| BarrierError::Failed {
            io_kind: kind.into(),
        };
        let Record::Session(record) = session.record.as_ref() else {
            return Err(failed("notASession"));
        };
        let header: Header = match &record.header {
            Slot::Inline(header) => header.clone(),
            Slot::Blob(blob) => session
                .encoded
                .0
                .blobs()
                .iter()
                .find(|b| b.digest == blob.descriptor().digest)
                .and_then(|b| serde_json::from_slice(&b.bytes).ok())
                .ok_or_else(|| failed("header"))?,
        };
        let start = record.base.as_ref().map_or(0, |b| b.end_ordinal_exclusive);
        let fold = Fold::from_session(
            record,
            header,
            FramePos {
                ordinal: start,
                file_no: 0,
                offset: 0,
            },
        );
        self.wait(lane, self.index.upsert(CatalogHead::of(&fold), DirtyMark::Set))
            .map_err(|e| BarrierError::Failed {
                io_kind: format!("index:{e}").into(),
            })?;
        let (writer, ack) = LogWriter::create(
            lane,
            &self.dir(id.as_str()),
            session.encoded.0.clone(),
            self.writer.clone(),
        )
        .map_err(barrier)?;
        let ordinal = ack.positions[0].ordinal;
        self.projector.send(ack.projection);
        Ok((
            Box::new(StoreLog {
                writer,
                projector: self.projector.clone(),
            }),
            ordinal,
        ))
    }
}

/// [`super::FeedFactory`] over WP-FEED's [`mixdog_core_base::feed::CoreFeed`]: one per actor instance,
/// with the thread-feed limits (SPEC §3.1: `ringBytes` 4 MiB).
pub struct CoreThreadFeeds {
    pub limits: mixdog_core_base::feed::FeedLimits,
    pub cpu: CpuInteractive,
}

impl CoreThreadFeeds {
    /// Thread feeds under the core's wire limits (`ringBytes`, `maxSnapshotBytes`); `cpu` runs
    /// their snapshot encodes.
    pub fn new(limits: &mixdog_app_protocol::limits::Limits, cpu: CpuInteractive) -> Self {
        let bytes = |n: u64| usize::try_from(n).unwrap_or(usize::MAX);
        Self {
            limits: mixdog_core_base::feed::FeedLimits { ring_bytes: bytes(limits.ring_bytes), max_snapshot_bytes: bytes(limits.max_snapshot_bytes) },
            cpu,
        }
    }
}

impl super::FeedFactory for CoreThreadFeeds {
    fn thread_feed(
        &self,
        id: mixdog_core_api::ids::FeedId,
        epoch: mixdog_core_api::ids::FeedEpoch,
        view: Arc<dyn mixdog_core_api::FeedView>,
    ) -> Arc<dyn mixdog_core_api::Feed> {
        Arc::new(mixdog_core_base::feed::CoreFeed::new(id, epoch, view, self.limits, self.cpu))
    }
}

/// A prompt as the row the prompt recompute reads (`prompt` only).
fn prompt_row(text: String) -> ItemRecord {
    ItemRecord {
        iid: mixdog_store::schema::bounded::Id::try_from("prompt").expect("short"),
        turn: None,
        role: None,
        form: mixdog_store::schema::record::Form::Message,
        model: false,
        visible: false,
        archive: None,
        op: None,
        prompt: Some(Slot::Inline(text)),
        refs: Vec::new().try_into().expect("empty list fits"),
        body: Slot::Inline(serde_json::Value::Null),
    }
}
