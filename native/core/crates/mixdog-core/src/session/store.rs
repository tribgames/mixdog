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
    Frames(Projection),
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
                    Projecting::Frames(projection) => drop(index.project(projection).await),
                    Projecting::Flush(done) => drop(done.send(())),
                }
            }
        });
        Self(tx)
    }

    fn send(&self, projection: Projection) {
        let _ = self.0.send(Projecting::Frames(projection));
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
    sessions: PathBuf,
    blobs: BlobStore,
    index: SqliteStore,
    writer: WriterDeps,
    projector: Projector,
    runtime: tokio::runtime::Handle,
}

impl StoreThreads {
    /// `data` is the data dir; `writer.blobs`/`writer.index` are the same stores. Call on the
    /// Tokio runtime the catalog writes and projections run on.
    pub fn new(data: &Path, blobs: BlobStore, index: SqliteStore, writer: WriterDeps) -> Self {
        Self {
            sessions: data.join("sessions"),
            blobs,
            projector: Projector::spawn(index.clone()),
            index,
            writer,
            runtime: tokio::runtime::Handle::current(),
        }
    }

    /// An index write from inside a lane job. Lane threads are not runtime threads; an inline
    /// lane (tests) runs on a runtime worker, which must hand off its tasks first.
    fn wait<F: std::future::Future>(&self, future: F) -> F::Output {
        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::task::block_in_place(|| self.runtime.block_on(future))
        } else {
            self.runtime.block_on(future)
        }
    }

    fn dir(&self, session: &str) -> PathBuf {
        self.sessions.join(session)
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
        let opened = log::open_log(lane, &self.dir(id.as_str()), &self.blobs, &self.index)
            .map_err(|e| Self::open_error(id, e))?;
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

impl super::seams::TurnIngest for SessionSearchTurns {
    fn ingest_turn(&self, id: &ThreadId, header: &mixdog_store::schema::record::Header, messages: Vec<Value>) {
        self.0.ingest_turn(mixdog_services::memory::session_search::ingest::IngestSession {
            id: id.as_str().to_owned(),
            messages,
            // `isAgentOnlySession` (store-summary-visibility.mjs).
            agent_only: mixdog_store::summary::session_visibility(header) == "agent-only",
        });
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
    fn read_head(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
    ) -> Result<HeadRead, CoreError> {
        let dir = self.dir(id.as_str());
        if !dir.is_dir() {
            return Err(Self::not_found(id));
        }
        let opened = log::open_log(lane, &dir, &self.blobs, &self.index)
            .map_err(|e| Self::open_error(id, e))?;
        Ok(HeadRead(Box::new(opened)))
    }

    fn read_window(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        head: &HeadRead,
    ) -> Result<WindowRead, CoreError> {
        // The window comes from the index: it must hold every barrier acked so far (a thread
        // unloaded and reopened in this process).
        self.wait(self.projector.flush());
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
            let Record::Queue(mut record) = self.frame_at(lane, id, dir, entry.enqueued)? else {
                return Err(unexpected("queue"));
            };
            if let Some(slot) = &record.entry {
                record.entry = Some(self.resolve(lane, slot)?);
            }
            queue.push((entry.enqueued.ordinal, record));
        }
        Ok(WindowRead(Box::new(Window {
            window,
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
            history_rev: fold.history_rev,
            lineage_start,
            runs: read.runs,
            approvals: read.approvals,
            queue: read.queue,
            window: read.window,
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
        self.wait(self.projector.flush());
        let dir = self.dir(id.as_str());
        let opened = log::open_log(lane, &dir, &self.blobs, &self.index)
            .map_err(|e| Self::open_error(id, e))?;
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
    ) -> Result<Vec<ItemRecord>, CoreError> {
        self.wait(self.projector.flush());
        let dir = self.dir(id.as_str());
        'read: loop {
            let opened = log::open_log(lane, &dir, &self.blobs, &self.index)
                .map_err(|e| Self::open_error(id, e))?;
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
            return Ok(rows);
        }
    }

    /// Pages newest first until the row is found: a switch anchors near the history's end.
    fn history_row(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        iid: &str,
    ) -> Result<Option<(u64, ItemRecord)>, CoreError> {
        self.wait(self.projector.flush());
        let dir = self.dir(id.as_str());
        'read: loop {
            let opened = log::open_log(lane, &dir, &self.blobs, &self.index)
                .map_err(|e| Self::open_error(id, e))?;
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
    ) -> Result<Option<u64>, CoreError> {
        self.wait(self.projector.flush());
        let opened = log::open_log(lane, &self.dir(id.as_str()), &self.blobs, &self.index)
            .map_err(|e| Self::open_error(id, e))?;
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
            self.wait(self.projector.flush());
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
        self.wait(self.index.mark_dirty(id.as_str()))
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
        self.wait(self.index.upsert(CatalogHead::of(&fold), DirtyMark::Set))
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

/// [`super::FeedFactory`] over WP-FEED's [`crate::feed::CoreFeed`]: one per actor instance,
/// with the thread-feed limits (SPEC §3.1: `ringBytes` 4 MiB).
pub struct CoreThreadFeeds {
    pub limits: crate::feed::FeedLimits,
    pub cpu: CpuInteractive,
}

impl super::FeedFactory for CoreThreadFeeds {
    fn thread_feed(
        &self,
        id: mixdog_core_api::ids::FeedId,
        epoch: mixdog_core_api::ids::FeedEpoch,
        view: Arc<dyn mixdog_core_api::FeedView>,
    ) -> Arc<dyn mixdog_core_api::Feed> {
        Arc::new(crate::feed::CoreFeed::new(id, epoch, view, self.limits, self.cpu))
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
