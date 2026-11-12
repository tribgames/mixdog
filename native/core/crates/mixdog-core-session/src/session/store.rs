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
pub struct Projector {
    queue: mpsc::UnboundedSender<Projecting>,
    /// Projections queued or running.
    pending: Arc<std::sync::atomic::AtomicUsize>,
    /// Set when the forwarding task has ended (a panic included): nothing waits on it any more.
    stopped: Arc<std::sync::atomic::AtomicBool>,
    /// How long an exact read waits ([`FENCE_BOUND`](super::thread_list::FENCE_BOUND); a test sets its own).
    bound: std::time::Duration,
    /// The number of the last projection sent.
    sent: Arc<std::sync::atomic::AtomicU64>,
    /// Per session, the number of its first projection the index failed to take: its frames are missing from the index until
    /// the next start re-projects the session from its log.
    lost: Arc<std::sync::Mutex<std::collections::HashMap<String, u64>>>,
}

enum Projecting {
    Frames(u64, Box<Projection>),
    /// Answered once every projection sent before it is committed.
    Flush(tokio::sync::oneshot::Sender<()>),
    /// Answers `reached` once every projection sent before it is committed, then takes nothing more until `release`
    /// resolves (dropped included): a log rewrite changes the files and the rows meanwhile.
    Hold { reached: tokio::sync::oneshot::Sender<()>, release: tokio::sync::oneshot::Receiver<()> },
}

/// Marks the projector stopped when its task ends, and says so once when a panic ended it.
struct StopMark(Arc<std::sync::atomic::AtomicBool>);

impl Drop for StopMark {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        if std::thread::panicking() {
            tracing::error!("the index projector stopped: lists answer what the index holds from now on, and the sessions written since are re-projected at the next start");
        }
    }
}

impl Projector {
    /// Starts the forwarding task on the current Tokio runtime.
    pub fn spawn(index: SqliteStore) -> Self {
        // A failed projection leaves the session dirty; reconcile re-projects it from its log at the next start. The open's own
        // reconcile needs no wait here: every way into the index waits for it and answers its failure (`SqliteStore`'s gate).
        Self::spawn_with(move |projection| {
            let index = index.clone();
            async move { index.project(projection).await.map_err(|error| error.to_string()) }
        })
    }

    /// The forwarding task over `project`, one projection at a time in barrier order.
    fn spawn_with<F, P>(mut project: P) -> Self
    where
        P: FnMut(Projection) -> F + Send + 'static,
        F: std::future::Future<Output = Result<(), String>> + Send,
    {
        let (queue, mut rx) = mpsc::unbounded_channel::<Projecting>();
        let pending = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let lost: Arc<std::sync::Mutex<std::collections::HashMap<String, u64>>> = Arc::default();
        let (done_count, mark, failed) = (pending.clone(), StopMark(stopped.clone()), lost.clone());
        tokio::spawn(async move {
            let _mark = mark;
            while let Some(msg) = rx.recv().await {
                match msg {
                    Projecting::Frames(number, projection) => {
                        let session = projection.session.clone();
                        match project(*projection).await {
                            Err(error) => {
                                tracing::error!(%session, %error, "the index did not take a projection: the session is re-projected at the next start");
                                failed.lock().unwrap_or_else(|e| e.into_inner()).entry(session).or_insert(number);
                            }
                            // A later projection carries the session's whole head (its header), so the index holds the header
                            // writes again: the header waits stop failing.
                            Ok(()) => drop(failed.lock().unwrap_or_else(|e| e.into_inner()).remove(&session)),
                        }
                        done_count.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    }
                    Projecting::Flush(done) => drop(done.send(())),
                    Projecting::Hold { reached, release } => {
                        drop(reached.send(()));
                        drop(release.await);
                        done_count.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    }
                }
            }
        });
        Self { queue, pending, stopped, bound: super::thread_list::FENCE_BOUND, sent: Arc::default(), lost }
    }

    /// Holds the index writes behind every projection sent so far: `reached` resolves once those are committed (an error
    /// when the projector is gone), and nothing sent later is taken, an exact read waiting included, until `release` is
    /// sent or dropped.
    fn hold(&self) -> (tokio::sync::oneshot::Receiver<()>, tokio::sync::oneshot::Sender<()>) {
        let (reached, reached_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = tokio::sync::oneshot::channel();
        self.pending.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.queue.send(Projecting::Hold { reached, release: release_rx }).is_err() {
            self.pending.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
        (reached_rx, release)
    }

    fn send(&self, projection: Projection) {
        // Counted before it is queued, so a reader that follows the barrier's ack sees it pending until the index holds it.
        self.pending.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let number = self.sent.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        if self.queue.send(Projecting::Frames(number, Box::new(projection))).is_err() {
            self.pending.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// [`caught_up`](Self::caught_up), then the writes of `session` acknowledged so far are in the index: an error with the
    /// reason when one of them failed to go in (the index lacks it until the next start re-projects the session), so a call
    /// that answers after this never reports a write the listings cannot show.
    async fn indexed(&self, session: &str) -> Result<(), CoreError> {
        let mark = self.sent.load(std::sync::atomic::Ordering::SeqCst);
        self.caught_up().await?;
        let lost = self.lost.lock().unwrap_or_else(|e| e.into_inner()).get(session).copied();
        match lost {
            Some(number) if number <= mark => Err(internal(
                "index-write-failed",
                &format_args!("the index did not take the change to session {session}: it is not listed until the next start re-projects it"),
            )),
            _ => Ok(()),
        }
    }

    /// The display class (D-reads-5: `thread/list` and the summary only). `None` when no projection is queued or running, or the
    /// projector has stopped (atomic loads); otherwise the wait for those already sent, with no bound of its own: the list bounds it
    /// ([`FENCE_BOUND`](super::thread_list::FENCE_BOUND)) and answers what the index holds past it.
    fn settle(&self) -> Option<futures::future::BoxFuture<'static, ()>> {
        if self.stopped.load(std::sync::atomic::Ordering::SeqCst) || self.pending.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            return None;
        }
        let projector = self.clone();
        Some(Box::pin(async move { projector.drained().await }))
    }

    /// The exact class: every other store read that depends on the index (an operation's dedupe, fences, activation's window,
    /// prompts, history, the context, the purge). `Ok` once every barrier acked so far has been through the index writer; an error
    /// that says the index is behind when it has not within [`FENCE_BOUND`](super::thread_list::FENCE_BOUND), or when the projector
    /// stopped with projections it never finished: such a read never answers from an index older than the write it depends on.
    async fn caught_up(&self) -> Result<(), CoreError> {
        let bound = self.bound;
        if mixdog_rt::time::timeout(bound, self.drained()).await.is_err() {
            return Err(internal("index-behind", &format_args!("the index has not taken the writes acknowledged before this read within {bound:?}")));
        }
        if self.stopped.load(std::sync::atomic::Ordering::SeqCst) && self.pending.load(std::sync::atomic::Ordering::SeqCst) != 0 {
            return Err(internal("index-behind", &"the index projector stopped before it took the writes acknowledged before this read"));
        }
        Ok(())
    }

    /// Until every projection sent so far has been through the index writer, or the projector is gone. Unbounded: only
    /// [`settle`](Self::settle) and [`caught_up`](Self::caught_up) use it, each with its class's rule at the bound.
    async fn drained(&self) {
        let (done, wait) = tokio::sync::oneshot::channel();
        if self.queue.send(Projecting::Flush(done)).is_ok() {
            drop(wait.await);
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
    /// `None` when the log could not be reopened after a rewrite: the next start settles it (`log_rewrite::recover`).
    writer: Option<LogWriter>,
    projector: Projector,
    redaction: Option<Redaction>,
}

/// The readers' side of a log rewrite (`log_rewrite`'s steps 4-8): every read of a session's log and index rows
/// holds it shared for its lane job; a rewrite holds it exclusively from moving the old folder out to removing its
/// parts, and moves the generation, so a read that spans jobs (the model context) sees that its earlier job read
/// another log and starts again.
type ReadGate = Arc<std::sync::RwLock<u64>>;

/// What the writer of a thread needs to take a value marked sensitive out of what it wrote before the mark
/// (`redactSessionFiles`, `session-writers.mjs`): the log rewritten (`log_rewrite`), the thread's index rows rebuilt
/// from it, and the writer reopened on it, between two barriers.
struct Redaction {
    marks: Arc<dyn super::seams::SensitiveMarks>,
    thread: ThreadId,
    data: PathBuf,
    index: SqliteStore,
    deps: WriterDeps,
    runtime: tokio::runtime::Handle,
    gate: ReadGate,
    /// The marks' version the log was rewritten for.
    seen: u64,
    /// A rewrite of this log stopped in this process (its parts are on disk): settled before anything else.
    unfinished: bool,
    /// Told each version the log was rewritten for, so a journaled mark is dropped once every session holding it is.
    journal: Option<Arc<super::mark_journal::MarksOnDisk>>,
    rewrites: Arc<Rewrites>,
}

/// The sensitive rewrites running now (each holds the projector and then the read gate): a read awaits none running
/// ([`ThreadStore::unheld`]) before it takes an io-interactive thread, so reads issued meanwhile wait off the lane rather
/// than holding its few threads blocked on the gate and filling its queue (where the next job, a row's commit included,
/// would be refused).
#[derive(Default)]
struct Rewrites {
    running: std::sync::atomic::AtomicUsize,
    done: tokio::sync::Notify,
}

/// One running rewrite; ends when dropped.
struct Rewriting(Arc<Rewrites>);

impl Rewrites {
    fn start(self: &Arc<Self>) -> Rewriting {
        self.running.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Rewriting(self.clone())
    }

    /// Once none runs, or after `bound` (the read then waits inside its job, as before).
    async fn idle(&self, bound: std::time::Duration) {
        let wait = async {
            loop {
                let done = self.done.notified();
                tokio::pin!(done);
                done.as_mut().enable();
                if self.running.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                    return;
                }
                done.await;
            }
        };
        if mixdog_rt::time::timeout(bound, wait).await.is_err() {
            tracing::warn!(bound_ms = bound.as_millis() as u64, "a read waited out its bound for a sensitive rewrite; it goes on and waits on the lane");
        }
    }
}

impl Drop for Rewriting {
    fn drop(&mut self) {
        self.0.running.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        self.0.done.notify_waiters();
    }
}

fn writer_lost() -> BarrierError {
    BarrierError::Indeterminate { io_kind: "writerLost".into() }
}

/// A test build's hold at a named point of a sensitive rewrite, run on the rewrite's own lane thread: `planned` once the plan
/// has read the log, `held` while the rewrite holds the reads. Compiled only into a build that asks for `crash-gates`.
#[cfg(feature = "crash-gates")]
pub mod rewrite_holds {
    type Hold = std::sync::Arc<dyn Fn() + Send + Sync>;
    static HOLDS: std::sync::Mutex<Vec<(&'static str, Hold)>> = std::sync::Mutex::new(Vec::new());

    /// Runs `hold` whenever a rewrite reaches `point`.
    pub fn set(point: &'static str, hold: impl Fn() + Send + Sync + 'static) {
        HOLDS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((point, std::sync::Arc::new(hold)));
    }

    pub(super) fn at(point: &str) {
        let holds: Vec<Hold> = HOLDS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().filter(|(p, _)| *p == point).map(|(_, h)| h.clone()).collect();
        for hold in holds {
            hold();
        }
    }
}

#[cfg(not(feature = "crash-gates"))]
mod rewrite_holds {
    pub(super) fn at(_point: &str) {}
}

impl Redaction {
    /// As `StoreThreads::wait`: a lane thread is no runtime thread; an inline lane (tests) runs on a runtime worker.
    #[allow(clippy::disallowed_methods, reason = "runs inside the io-durability job (lane proof argument)")]
    fn wait<T>(&self, future: impl std::future::Future<Output = T>) -> T {
        let block = || self.runtime.block_on(future);
        if tokio::runtime::Handle::try_current().is_ok() { tokio::task::block_in_place(block) } else { block() }
    }

    /// Steps 3-8 of `log_rewrite` from wherever this log's rewrite stands, with every reader out: the writer's handle is
    /// closed first and the writer reopened on the log in place after, whatever the outcome. A rewrite stopped before
    /// step 5 puts the old folder back, so the thread goes on over its old log and the next attempt builds again.
    fn settle(&mut self, lane: &InLane<DurabilityIo>, writer: &mut Option<LogWriter>) -> bool {
        let gate = self.gate.clone();
        let mut generation = gate.write().unwrap_or_else(std::sync::PoisonError::into_inner);
        *generation += 1;
        rewrite_holds::at("held");
        *writer = None;
        let session = self.thread.as_str().to_owned();
        let (index, blobs) = (self.index.clone(), self.deps.blobs.clone());
        let mut index_step = |superseded| {
            let rewrite = mixdog_store::sqlite::Rewritten { data: self.data.clone(), session: session.clone(), dirty: DirtyMark::Set, superseded, blobs: blobs.clone() };
            self.wait(index.reproject(rewrite)).map_err(|e| e.to_string())
        };
        let settled = mixdog_store::log_rewrite::settle(lane, &self.data, &session, &*self.deps.io, &self.deps.blobs, &mut index_step);
        if let Err(error) = &settled {
            tracing::warn!(thread = %session, "the sensitive rewrite of the log stopped; it is tried again at the next barrier: {error}");
            if let Err(error) = mixdog_store::log_rewrite::undo_move(lane, &self.data, &session) {
                tracing::error!(thread = %session, "the old log could not be put back; the next start settles the rewrite: {error}");
            }
        }
        self.unfinished = settled.is_err();
        let dir = self.data.join("sessions").join(&session);
        let reopened = log::open_log(lane, &dir, &self.deps.blobs, &*self.deps.index)
            .map_err(|e| e.to_string())
            .and_then(|opened| LogWriter::open(lane, opened, self.deps.clone()).map_err(|e| e.to_string()));
        match reopened {
            Ok(reopened) => *writer = Some(reopened),
            Err(error) => tracing::error!(thread = %session, "the log could not be reopened after its sensitive rewrite; the next start settles it: {error}"),
        }
        drop(generation);
        settled.is_ok()
    }
}

impl StoreLog {
    /// Runs before the barrier of a batch when the thread took a mark since the last rewrite, or a rewrite of its log
    /// stopped: `log_rewrite`'s steps, with the index taking no projection meanwhile (a read that waits for it sees the
    /// new rows). What fails is tried again at the next barrier, or settled by the next start once the intent is on disk.
    fn redact_written(&mut self, lane: &InLane<DurabilityIo>) {
        let Some(redaction) = &mut self.redaction else { return };
        let version = redaction.marks.version(&redaction.thread);
        if version == redaction.seen && !redaction.unfinished {
            return;
        }
        let _rewriting = redaction.rewrites.start();
        let (reached, release) = self.projector.hold();
        if redaction.wait(reached).is_err() {
            return;
        }
        // A rewrite left unfinished goes first: a new plan reads the log it puts in place.
        if redaction.unfinished && !redaction.settle(lane, &mut self.writer) {
            drop(release);
            return;
        }
        if version != redaction.seen {
            let session = redaction.thread.as_str().to_owned();
            let mut replace = redaction.marks.rewriter(&redaction.thread);
            let planned = mixdog_store::log_rewrite::plan(lane, &redaction.data, &session, &*redaction.deps.io, &redaction.deps.blobs, &mut *replace);
            drop(replace);
            rewrite_holds::at("planned");
            match planned {
                Ok(None) => redaction.seen = version,
                // The new blobs' pins hold until the rebuilt rows name them.
                Ok(Some(pins)) => {
                    if redaction.settle(lane, &mut self.writer) {
                        redaction.seen = version;
                    }
                    drop(pins);
                }
                Err(error) => tracing::warn!(thread = %session, "the sensitive rewrite of the log could not be planned; it is tried again at the next barrier: {error}"),
            }
        }
        if redaction.seen == version
            && let Some(journal) = &redaction.journal
        {
            journal.applied(redaction.thread.as_str(), version);
        }
        drop(release);
    }

    /// The batch as the log stores it now: a record encoded before the thread's newest mark (encoding runs ahead of the
    /// barrier) is projected again and encoded again when that changes it, so no value marked meanwhile is appended.
    fn stored_batch(&self, batch: &[CommitRecord]) -> Result<Vec<Encoded>, BarrierError> {
        let mut encoded: Vec<Encoded> = batch.iter().map(|c| c.encoded.0.clone()).collect();
        let Some(redaction) = &self.redaction else { return Ok(encoded) };
        if redaction.marks.version(&redaction.thread) == 0 {
            return Ok(encoded);
        }
        let mut replace = redaction.marks.rewriter(&redaction.thread);
        for (record, out) in batch.iter().zip(&mut encoded) {
            if let Some(next) = replace(record.record.as_ref()) {
                *out = mixdog_store::encode::encode_record(next).map_err(|e| BarrierError::Failed { io_kind: format!("encode:{e}").into() })?;
            }
        }
        Ok(encoded)
    }
}

impl SessionLog for StoreLog {
    fn commit(
        &mut self,
        lane: &InLane<DurabilityIo>,
        batch: &[CommitRecord],
    ) -> Result<Vec<u64>, BarrierError> {
        self.redact_written(lane);
        let encoded = self.stored_batch(batch)?;
        let writer = self.writer.as_mut().ok_or_else(writer_lost)?;
        let ack = writer.append_barrier(lane, encoded).map_err(barrier)?;
        let ordinals = ack.positions.iter().map(|p| p.ordinal).collect();
        self.projector.send(ack.projection);
        Ok(ordinals)
    }

    fn retry(&mut self, lane: &InLane<DurabilityIo>) -> Result<(), BarrierError> {
        self.writer.as_mut().ok_or_else(writer_lost)?.retry_storage(lane).map_err(barrier)
    }

    fn redact(&mut self, lane: &InLane<DurabilityIo>) {
        self.redact_written(lane);
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
    /// The marks whose values the logs keep out of what they wrote before (bound once, by the composition).
    sensitive: std::sync::OnceLock<Arc<dyn super::seams::SensitiveMarks>>,
    /// The marks' journal, bound with them.
    journal: std::sync::OnceLock<Arc<super::mark_journal::MarksOnDisk>>,
    gate: ReadGate,
    rewrites: Arc<Rewrites>,
}

impl super::thread_list::ListFence for StoreThreads {
    fn pending(&self) -> Option<futures::future::BoxFuture<'static, ()>> {
        self.projector.settle()
    }
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
            sensitive: std::sync::OnceLock::new(),
            journal: std::sync::OnceLock::new(),
            gate: ReadGate::default(),
            rewrites: Arc::default(),
        }
    }

    /// Holds the index projections (as a rewrite does), for a test of what waits on them.
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    pub(super) fn hold_index(&self) -> (tokio::sync::oneshot::Receiver<()>, tokio::sync::oneshot::Sender<()>) {
        self.projector.hold()
    }

    /// The read gate, shared for one lane job of a read (see [`ReadGate`]). Taken after any wait on the projector: a
    /// rewrite holds the projector while it waits for the gate.
    fn read_gate(&self) -> std::sync::RwLockReadGuard<'_, u64> {
        self.gate.read().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// At start, before any thread is served: the marks this data dir saved are known again, and a thread that owes a rewrite
    /// for one has it.
    #[allow(clippy::disallowed_methods, reason = "the session folder is looked up inside the durability lane job")]
    pub async fn settle_marks(&self, durability: DurabilityIo) -> Result<(), CoreError> {
        let (Some(marks), Some(journal)) = (self.sensitive.get(), self.journal.get()) else { return Ok(()) };
        let refused = |what: &str| internal("sensitive-marks", &what);
        // Each job waits out a full lane: a mark owed is settled, not skipped for a busy one.
        use mixdog_core_base::support::on_lane_wait as wait;
        let never = mixdog_rt::CancellationToken::new();
        let loaded = {
            let journal = journal.clone();
            wait(self.maintenance, &never, move |_lane| journal.load()).await?
        };
        for (from, to) in loaded.carries {
            marks.carry(&ThreadId::from(from.as_str()), &ThreadId::from(to.as_str()));
        }
        // Each pending mark is marked again (journaled anew, carried along the carries), and its old file goes.
        for (n, origin, values, sessions) in loaded.pending {
            for session in std::iter::once(origin).chain(sessions) {
                marks.restore(&ThreadId::from(session.as_str()), &values);
            }
            let journal = journal.clone();
            wait(self.maintenance, &never, move |_lane| journal.forget(n)).await?;
        }
        for session in journal.owed() {
            let (id, dir) = (ThreadId::from(session.as_str()), self.dir(&session));
            let (deps, journal) = (self.writer.clone(), journal.clone());
            let opened = wait(durability, &never, move |lane| {
                if !dir.is_dir() {
                    // A session deleted since holds nothing.
                    journal.applied(&session, u64::MAX);
                    return Ok(None);
                }
                let opened = log::open_log(lane, &dir, &deps.blobs, &*deps.index).map_err(|e| e.to_string())?;
                LogWriter::open(lane, opened, deps).map(Some).map_err(|e| e.to_string())
            })
            .await?
            .map_err(|error| refused(&error))?;
            let Some(writer) = opened else { continue };
            let mut log = self.store_log(&id, writer);
            wait(durability, &never, move |lane| log.redact(lane)).await?;
        }
        Ok(())
    }

    /// The marks the session actors take (`SessionDeps::sensitive`, the same instance): a log rewrites what it wrote before
    /// a mark at its next barrier, and the marks are journaled under the data dir. A second bind is refused.
    pub fn redact_with(&self, marks: Arc<dyn super::seams::SensitiveMarks>) -> Result<(), Arc<dyn super::seams::SensitiveMarks>> {
        self.sensitive.set(marks.clone())?;
        let journal = Arc::new(super::mark_journal::MarksOnDisk::new(&self.data));
        if marks.journal_with(journal.clone()) {
            let _ = self.journal.set(journal);
        }
        Ok(())
    }

    fn store_log(&self, id: &ThreadId, writer: LogWriter) -> Box<dyn SessionLog> {
        let redaction = self.sensitive.get().map(|marks| Redaction {
            marks: marks.clone(),
            thread: id.clone(),
            data: self.data.clone(),
            index: self.index.clone(),
            deps: self.writer.clone(),
            runtime: self.runtime.clone(),
            gate: self.gate.clone(),
            seen: 0,
            unfinished: false,
            journal: self.journal.get().cloned(),
            rewrites: self.rewrites.clone(),
        });
        Box::new(StoreLog { writer: Some(writer), projector: self.projector.clone(), redaction })
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
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    pub(crate) async fn projected(&self) {
        self.projector.drained().await;
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
            let found = self.index.dividers_on_lane(lane, lineage, cut, level, from, u64::MAX).map_err(|e| internal("dividers", &e))?;
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
    /// The read gate's generation its first job read under.
    generation: u64,
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
    /// The first page of the read, over the lineage as of now; the caller holds the read gate at `generation`.
    fn context_start(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        generation: u64,
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
            generation,
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

/// [`super::seams::SensitiveMarks`] over the process's sensitive-value store, with the bodies the store's projection
/// redacted, as they were committed: thread → item id → body. Like the store's values, they stay for the life of the
/// process (Node's loaded session holds the same text in memory, `sensitive-values.mjs:12`), and nothing writes them.
pub struct SensitiveMarksOf {
    store: Arc<mixdog_services::memory::sensitive::SensitiveStore>,
    held: std::sync::Mutex<std::collections::HashMap<String, std::collections::HashMap<String, Value>>>,
}

impl SensitiveMarksOf {
    pub fn new(store: Arc<mixdog_services::memory::sensitive::SensitiveStore>) -> Self {
        Self { store, held: std::sync::Mutex::default() }
    }

    fn held_bodies(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, std::collections::HashMap<String, Value>>> {
        self.held.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `_withSensitiveHeaderRedacted` (`store/serialize.mjs`, the Node fix `node-fix-sensitive-header-summary.patch`): the
    /// header fields that hold the conversation's text (the title, from the first prompt) or a tool call's arguments (the
    /// repeat-failure guards keep each failed call's signature) take the marker. True when one changed.
    fn header_redacted(&self, session: &str, header: &mut mixdog_store::schema::record::Header) -> bool {
        let mut changed = false;
        let mut text = |value: &mut Value| {
            if let Value::String(text) = value {
                let next = self.store.redact_text(session, text);
                if next != *text {
                    *text = next;
                    changed = true;
                }
            }
        };
        if let Some(title) = header.get_mut("title") {
            text(title);
        }
        for key in ["_repeatFailGuard", "_repeatArgShapeFailGuard"] {
            if let Some(sig) = header.get_mut(key).and_then(|guard| guard.get_mut("sig")) {
                text(sig);
            }
        }
        if let Some(Value::Array(history)) = header.get_mut("_repeatFailHistory") {
            history.iter_mut().for_each(&mut text);
        }
        changed
    }

    /// Every string of an inline slot with the thread's values replaced; true when one changed.
    fn text_redacted(&self, session: &str, slot: Option<&mut mixdog_store::schema::blob::Slot<Value>>) -> bool {
        fn walk(store: &mixdog_services::memory::sensitive::SensitiveStore, session: &str, value: &mut Value) -> bool {
            match value {
                Value::String(text) => {
                    let next = store.redact_text(session, text);
                    let changed = next != *text;
                    *text = next;
                    changed
                }
                Value::Array(items) => items.iter_mut().fold(false, |changed, item| walk(store, session, item) | changed),
                Value::Object(map) => map.values_mut().fold(false, |changed, item| walk(store, session, item) | changed),
                Value::Null | Value::Bool(_) | Value::Number(_) => false,
            }
        }
        match slot {
            Some(mixdog_store::schema::blob::Slot::Inline(value)) => walk(&self.store, session, value),
            _ => false,
        }
    }

    /// `record` as the log stores it, and each message body it carries with the body as committed when the projection
    /// changed it (`None`: stored as it is). `None` for a record stored as it is.
    #[allow(clippy::type_complexity)]
    fn projected(&self, session: &str, record: &mixdog_store::schema::record::Record) -> (Option<mixdog_store::schema::record::Record>, Vec<(String, Option<Value>)>) {
        use mixdog_store::schema::blob::Slot;
        use mixdog_store::schema::record::Record;
        let mut out = record.clone();
        // (item id, the body as committed when the projection changed it).
        let mut bodies: Vec<(String, Option<Value>)> = Vec::new();
        let mut project = |iid: &str, body: &mut Value| {
            let next = self.store.redact_message(session, body);
            if next == *body {
                bodies.push((iid.to_owned(), None));
            } else {
                bodies.push((iid.to_owned(), Some(std::mem::replace(body, next))));
            }
        };
        let mut prompt_changed = false;
        match &mut out {
            Record::Item(row) => {
                if let Slot::Inline(body) = &mut row.body {
                    project(row.iid.as_str(), body);
                }
                // The prompt-history text is the row's own text as it displays (`content`'s text): stored as its content is.
                if let Some(Slot::Inline(prompt)) = &mut row.prompt
                    && let Value::String(next) = self.store.redact_content(session, &Value::String(prompt.clone()))
                    && next != *prompt
                {
                    *prompt = next;
                    prompt_changed = true;
                }
            }
            Record::Amend(amend) => {
                if let Slot::Inline(body) = &mut amend.body {
                    project(amend.iid.as_str(), body);
                }
            }
            Record::Compacted(compacted) => {
                if let Slot::Inline(entries) = &mut compacted.replacement {
                    for entry in entries {
                        project(&entry.iid, &mut entry.body);
                    }
                }
            }
            Record::Meta(meta) => {
                if let Slot::Inline(change) = &mut meta.change {
                    prompt_changed = self.header_redacted(session, &mut change.set);
                }
            }
            Record::Session(start) => {
                if let Slot::Inline(header) = &mut start.header {
                    prompt_changed = self.header_redacted(session, header);
                }
            }
            Record::Checkpoint(checkpoint) => {
                if let Slot::Inline(state) = &mut checkpoint.state {
                    prompt_changed = self.header_redacted(session, &mut state.header);
                }
            }
            // Text that is no message: a run's failure detail, an op's error, an approval's request (a tool call's
            // arguments) or decision, a queued message: every string of them takes the marker.
            Record::Run(run) => prompt_changed = self.text_redacted(session, run.detail.as_mut()),
            Record::Op(op) => prompt_changed = self.text_redacted(session, op.detail.as_mut()),
            Record::Approval(approval) => prompt_changed = self.text_redacted(session, approval.body.as_mut()),
            Record::Queue(queue) => prompt_changed = self.text_redacted(session, queue.entry.as_mut()),
            // No text: positions, ids, a provider and model id.
            Record::Rewind(_) | Record::ModelSwitch(_) => return (None, Vec::new()),
        }
        let changed = prompt_changed || bodies.iter().any(|(_, body)| body.is_some());
        (changed.then_some(out), bodies)
    }
}

impl super::seams::SensitiveMarks for SensitiveMarksOf {
    fn on_marked(&self, thread: &ThreadId, listener: Box<dyn Fn() + Send + Sync>) -> Box<dyn Send> {
        Box::new(self.store.on_marked(thread.as_str(), move |_| listener()))
    }

    fn remember(&self, thread: &ThreadId, calls: &[Value]) -> bool {
        self.store.remember(thread.as_str(), calls)
    }

    fn carry(&self, from: &ThreadId, to: &ThreadId) {
        self.store.carry(from.as_str(), to.as_str());
    }

    fn on_carried(&self, listener: Box<dyn Fn(&ThreadId) + Send + Sync>) -> bool {
        self.store.on_carried(move |session| listener(&ThreadId::from(session)))
    }

    fn restore(&self, thread: &ThreadId, values: &[String]) -> bool {
        self.store.restore(thread.as_str(), values)
    }

    fn journal_with(&self, journal: Arc<dyn mixdog_services::memory::sensitive::MarkJournal>) -> bool {
        self.store.journal_with(journal)
    }

    fn stored(&self, thread: &ThreadId, record: &mixdog_store::schema::record::Record) -> Option<mixdog_store::schema::record::Record> {
        let session = thread.as_str();
        // A thread with no marked value holds no redacted body either (both live for the process).
        if self.store.version(session) == 0 {
            return None;
        }
        let (out, bodies) = self.projected(session, record);
        let mut held = self.held_bodies();
        let thread_held = held.entry(session.to_owned()).or_default();
        for (iid, body) in bodies {
            match body {
                Some(body) => {
                    thread_held.insert(iid, body);
                }
                // A later body of the row (an amend) that holds no value is stored as it is and read as stored.
                None => {
                    thread_held.remove(&iid);
                }
            }
        }
        out
    }

    fn version(&self, thread: &ThreadId) -> u64 {
        self.store.version(thread.as_str())
    }

    fn redact_text(&self, thread: &ThreadId, text: &str) -> String {
        self.store.redact_text(thread.as_str(), text)
    }

    fn rewriter<'a>(&'a self, thread: &ThreadId) -> Box<dyn FnMut(&mixdog_store::schema::record::Record) -> Option<mixdog_store::schema::record::Record> + 'a> {
        let session = thread.as_str().to_owned();
        // The rows whose body this pass took out; a later body of one of them that holds no value is read as stored.
        let mut taken = std::collections::HashSet::new();
        Box::new(move |record| {
            if self.store.version(&session) == 0 {
                return None;
            }
            let (out, bodies) = self.projected(&session, record);
            let mut held = self.held_bodies();
            let thread_held = held.entry(session.clone()).or_default();
            for (iid, body) in bodies {
                match body {
                    // The record handed here may already be a stored copy (redacted for an earlier mark): the body the
                    // first redaction kept, the committed one, stays.
                    Some(body) => {
                        thread_held.entry(iid.clone()).or_insert(body);
                        taken.insert(iid);
                    }
                    None if taken.contains(&iid) => {
                        thread_held.remove(&iid);
                    }
                    None => {}
                }
            }
            out
        })
    }

    fn redacted(&self, thread: &ThreadId, messages: &[Value]) -> Vec<Value> {
        self.store.redact_messages(thread.as_str(), messages)
    }

    fn held(&self, thread: &ThreadId, rows: &mut [(ItemId, Value)]) {
        let held = self.held_bodies();
        let Some(bodies) = held.get(thread.as_str()) else {
            return;
        };
        for (iid, body) in rows {
            if let Some(full) = bodies.get(iid.as_str()) {
                body.clone_from(full);
            }
        }
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
        let _gate = self.read_gate();
        if !self.dir(id.as_str()).is_dir() {
            return Err(Self::not_found(id));
        }
        Ok(HeadRead(Box::new(self.open(lane, id)?)))
    }

    #[allow(clippy::disallowed_methods, reason = "runs inside an interactive-io lane job (lane proof argument)")]
    fn read_header(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Header, CoreError> {
        let _gate = self.read_gate();
        if !self.dir(id.as_str()).is_dir() {
            return Err(Self::not_found(id));
        }
        Ok(self.open(lane, id)?.fold.header.clone())
    }

    fn read_log_id(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<String, CoreError> {
        let _gate = self.read_gate();
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
        self.wait(lane, self.projector.caught_up())?;
        // The head was read in an earlier job; only the thread's own loaded actor rewrites its log, and a head is read
        // to load the thread, so no rewrite of this log comes between the two.
        let _gate = self.read_gate();
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
        self.wait(lane, self.projector.caught_up())?;
        let _gate = self.read_gate();
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
        self.wait(lane, self.projector.caught_up())?;
        let _gate = self.read_gate();
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
        self.wait(lane, self.projector.caught_up())?;
        let _gate = self.read_gate();
        let Some(row) = self.index.thread_op_on_lane(lane, id.as_str(), op).map_err(|e| internal("thread-op", &e))? else {
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
        self.wait(lane, self.projector.caught_up())?;
        self.index.fenced_ops_on_lane(lane, id.as_str()).map_err(|e| internal("fenced-ops", &e))
    }

    /// Pages newest first until the row is found: a switch anchors near the history's end.
    fn history_row(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        iid: &str,
    ) -> Result<Option<(u64, ItemRecord)>, CoreError> {
        self.wait(lane, self.projector.caught_up())?;
        let _gate = self.read_gate();
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
        self.wait(lane, self.projector.caught_up())?;
        let _gate = self.read_gate();
        let opened = self.open(lane, id)?;
        let lineage = self.lineage(lane, &opened.fold)?;
        self.index
            .compaction_entry_on_lane(lane, &lineage, opened.fold.base_cut, iid)
            .map_err(|e| internal("history", &e))
    }

    fn indexed(&self, id: &ThreadId) -> futures::future::BoxFuture<'static, Result<(), CoreError>> {
        let (projector, session) = (self.projector.clone(), id.as_str().to_owned());
        Box::pin(async move { projector.indexed(&session).await })
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

    fn unheld(&self) -> futures::future::BoxFuture<'static, ()> {
        let (rewrites, projector) = (self.rewrites.clone(), self.projector.clone());
        Box::pin(async move {
            rewrites.idle(super::thread_list::FENCE_BOUND).await;
            // The read's job waits for the index again (on the lane, where it must hold); waited here first, that wait is
            // already over when the job takes its thread. A failure is the job's to report.
            let _ = projector.caught_up().await;
        })
    }

    fn copies_of(&self, id: &ThreadId) -> futures::future::BoxFuture<'static, Result<super::seams::OffloadCopies, CoreError>> {
        let (projector, index, id) = (self.projector.clone(), self.index.clone(), id.as_str().to_owned());
        Box::pin(async move {
            projector.caught_up().await?;
            let found = index.offload_referencers(&id, mixdog_store::offload_sources::boot()).await.map_err(|e| internal("copies", &e))?;
            if let Some((heir, source)) = found.copying {
                return Err(internal("copies", &format!("the session {heir} is still inheriting the conversation of {source}")));
            }
            Ok(super::seams::OffloadCopies { copies: found.sessions, unknown: found.unknown, unreadable: found.unreadable })
        })
    }

    fn record_offload_scan(&self, session: &str, ordinal: i64, sources: Vec<String>) -> futures::future::BoxFuture<'static, Result<(), CoreError>> {
        let (index, session) = (self.index.clone(), session.to_owned());
        Box::pin(async move { index.record_offload_scan(&session, ordinal, sources).await.map_err(|e| internal("copies", &e)) })
    }

    fn purge_deleted(&self) -> futures::future::BoxFuture<'static, Result<Vec<String>, CoreError>> {
        let (projector, index, lane, data) = (self.projector.clone(), self.index.clone(), self.maintenance, self.data.clone());
        Box::pin(async move {
            projector.caught_up().await?;
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
            self.wait(lane, self.projector.caught_up())?;
            let gate = self.read_gate();
            return Ok(ContextRead(Box::new(self.context_start(lane, id, *gate)?)));
        };
        let gate = self.read_gate();
        let mut state = *read.0.downcast::<ContextState>().expect("StoreThreads context");
        // A log rewritten since the read's earlier jobs: their positions and blobs are of the old log, so it starts again.
        if state.generation != *gate {
            return Ok(ContextRead(Box::new(self.context_start(lane, id, *gate)?)));
        }
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
                    return Ok(ContextRead(Box::new(self.context_start(lane, id, *gate)?)));
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
        let ContextState { lineage, cut, out, at, generation } = state;
        let rest = |at| ContextState { lineage, cut, out, at, generation };
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
        Ok(self.store_log(id, writer))
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
        Ok((self.store_log(id, writer), ordinal))
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

#[cfg(test)]
mod projector_tests {
    use super::*;
    use mixdog_store::sqlite::SqliteStore;
    use mixdog_store::summary::CatalogHead;

    async fn index_in(data: &Path) -> SqliteStore {
        let tokens = mixdog_rt::testing::tokens();
        let root = data.to_path_buf();
        mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index")
    }

    fn empty_projection(session: &str) -> Projection {
        let head = CatalogHead { session: session.into(), log_id: "L".into(), base_session: None, header: serde_json::Map::new() };
        Projection { session: session.into(), frames: Vec::new(), head, pins: Vec::new() }
    }

    /// What a list asks of the projector: pending from the moment a projection is queued until the index holds it, and nothing
    /// to wait for (no future at all) when idle.
    #[tokio::test]
    async fn a_queued_projection_is_pending_until_the_index_holds_it() {
        let data = crate::session::testing::DataDir::default();
        let projector = Projector::spawn(data.index(index_in(data.path()).await));
        assert!(projector.settle().is_none(), "idle");
        projector.send(empty_projection("sess_ok"));
        let wait = projector.settle().expect("a queued projection is pending");
        wait.await;
        assert!(projector.settle().is_none(), "the index holds it");
    }

    /// A projector whose task died (a panic while projecting) leaves its count of queued projections behind; a list must not wait
    /// on it from then on: the wait that was pending ends, and no later list gets one.
    #[tokio::test]
    async fn a_projector_that_died_is_not_waited_on() {
        let projector = Projector::spawn_with(|_| async { panic!("the projection panicked") });
        projector.send(empty_projection("sess_lost"));
        projector.settle().expect("a queued projection is pending").await;
        assert!(projector.settle().is_none(), "a dead projector is waited on");
    }

    /// A session write the index failed to take is never answered as in the index: the wait after it (`ThreadStore::indexed`,
    /// which a header patch awaits before it answers) fails with the reason, and keeps failing for that session, as the index
    /// keeps lacking it until the next start re-projects it; another session's write that went in answers done.
    #[tokio::test]
    async fn a_write_the_index_failed_to_take_is_not_answered_as_indexed() {
        let projector = Projector::spawn_with(|projection: Projection| {
            let session = projection.session.clone();
            async move { if session == "sess_bad" { Err("disk I/O error".to_owned()) } else { Ok(()) } }
        });
        projector.send(empty_projection("sess_bad"));
        projector.send(empty_projection("sess_ok"));
        let failed = |result: Result<(), CoreError>| match result {
            Err(CoreError::Internal { incident_id }) => assert!(incident_id.contains("index-write-failed") && incident_id.contains("sess_bad"), "{incident_id}"),
            Ok(()) => panic!("a write the index did not take was answered as indexed"),
            Err(other) => panic!("{other:?}"),
        };
        failed(projector.indexed("sess_bad").await);
        projector.indexed("sess_ok").await.expect("the write that went in");
        failed(projector.indexed("sess_bad").await);
    }

    /// Once a later projection of the session goes in, the index holds its head again (a projection carries the whole header),
    /// so the header waits after it answer done instead of failing until a restart.
    #[tokio::test]
    async fn a_session_the_index_took_again_is_answered_as_indexed() {
        let refused = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let projector = Projector::spawn_with({
            let refused = refused.clone();
            move |_: Projection| {
                let refuse = refused.swap(false, std::sync::atomic::Ordering::SeqCst);
                async move { if refuse { Err("disk I/O error".to_owned()) } else { Ok(()) } }
            }
        });
        projector.send(empty_projection("sess_bad"));
        assert!(projector.indexed("sess_bad").await.is_err(), "the refused write");
        projector.send(empty_projection("sess_bad"));
        projector.indexed("sess_bad").await.expect("the index holds the session again");
    }

    /// The exact class's wait: behind a projection that never ends it still waits one tick before
    /// [`FENCE_BOUND`](super::super::thread_list::FENCE_BOUND), and at the bound it fails, saying the index is behind; it never goes
    /// on to read.
    #[tokio::test(start_paused = true)]
    async fn an_exact_read_behind_a_stuck_projection_fails_at_the_bound() {
        let bound = super::super::thread_list::FENCE_BOUND;
        let _clock = crate::session::testing::HeldClock::hold();
        let projector = Projector::spawn_with(|_| std::future::pending::<Result<(), String>>());
        projector.send(empty_projection("sess_stuck"));
        let read = projector.caught_up();
        tokio::pin!(read);
        let mut polled = || read.as_mut().poll(&mut std::task::Context::from_waker(std::task::Waker::noop()));
        assert!(polled().is_pending(), "the read did not wait for the queued projection");
        tokio::time::advance(bound - std::time::Duration::from_millis(1)).await;
        assert!(polled().is_pending(), "the read stopped waiting before the bound");
        tokio::time::advance(std::time::Duration::from_millis(1)).await;
        match polled() {
            std::task::Poll::Ready(Err(CoreError::Internal { incident_id })) => assert!(incident_id.contains("index-behind"), "{incident_id}"),
            other => panic!("at the bound the exact read answered {other:?}, not that the index is behind"),
        }
    }

    /// Every exact read of the store (an operation's dedupe, the fences an activation restores, activation's window, prompt rows,
    /// the whole history, the switch anchor's row, the compaction entry, the model's context, the purge) fails, saying the index is
    /// behind, while an acknowledged write is still queued for the index past the bound: none answers absent, empty or stale. The
    /// operation gate's read (`ThreadOpStore::get`) passes `thread_op`'s error on, so an acknowledged operation is never taken as
    /// unseen. (The bound is zero here: the projection is stuck before any read starts.)
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_exact_read_fails_while_an_acknowledged_write_is_behind_the_bound() {
        let data = crate::session::testing::DataDir::default();
        let index = data.index(index_in(data.path()).await);
        let tokens = mixdog_rt::testing::tokens();
        let store = StoreThreads::over_data_dir(data.path(), index, Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("store");
        let mut stuck = Projector::spawn_with(|_| std::future::pending::<Result<(), String>>());
        stuck.bound = std::time::Duration::ZERO;
        stuck.send(empty_projection("sess_a"));
        let store = Arc::new(StoreThreads { projector: stuck, ..store });
        let id = ThreadId::from("sess_a");
        let reads = mixdog_rt::LaneToken::submit(tokens.interactive_io, &mixdog_rt::CancellationToken::new(), {
            let store = store.clone();
            move |lane| {
                let failed = |result: Result<(), CoreError>| match result {
                    Err(CoreError::Internal { incident_id }) if incident_id.contains("index-behind") => None,
                    other => Some(format!("{other:?}")),
                };
                vec![
                    ("thread_op", failed(ThreadStore::thread_op(&*store, lane, &id, "op-1").map(drop))),
                    ("fenced_ops", failed(ThreadStore::fenced_ops(&*store, lane, &id).map(drop))),
                    ("read_window", failed(ThreadStore::read_window(&*store, lane, &id, &HeadRead(Box::new(()))).map(drop))),
                    ("user_rows", failed(ThreadStore::user_rows(&*store, lane, &id).map(drop))),
                    ("history_rows", failed(ThreadStore::history_rows(&*store, lane, &id).map(drop))),
                    ("history_row", failed(ThreadStore::history_row(&*store, lane, &id, "i-1").map(drop))),
                    ("compaction_entry", failed(ThreadStore::compaction_entry(&*store, lane, &id, "i-1").map(drop))),
                    ("context_io", failed(ThreadStore::context_io(&*store, lane, &id, None).map(drop))),
                ]
            }
        })
        .expect("lane")
        .await
        .expect("job ran");
        let purge = ThreadStore::purge_deleted(&*store).await;
        let mut answered: Vec<String> = reads.into_iter().filter_map(|(read, other)| other.map(|other| format!("{read}: {other}"))).collect();
        if !matches!(&purge, Err(CoreError::Internal { incident_id }) if incident_id.contains("index-behind")) {
            answered.push(format!("purge_deleted: {purge:?}"));
        }
        assert!(answered.is_empty(), "exact reads that did not fail as behind: {answered:?}");
    }

    /// The index reads a store job makes on the read lane run on the job's own thread: a job never waits for a lane slot behind
    /// itself. The lane here refuses every job submitted from inside the job, as a lane whose every thread is held and whose queue is
    /// full refuses it; the reads still answer.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_store_read_inside_a_lane_job_takes_no_second_lane_slot() {
        let data = crate::session::testing::DataDir::default();
        let index = data.index(index_in(data.path()).await);
        let tokens = mixdog_rt::testing::tokens();
        let store = Arc::new(
            StoreThreads::over_data_dir(data.path(), index, Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()), tokens.maintenance_io)
                .await
                .expect("store"),
        );
        let id = ThreadId::from("sess_unknown");
        let (ops, fenced) = mixdog_rt::LaneToken::submit(tokens.interactive_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            let _held = mixdog_rt::testing::refuse_jobs_on_this_thread();
            (ThreadStore::thread_op(&*store, lane, &id, "op-1").map(|op| op.is_none()), ThreadStore::fenced_ops(&*store, lane, &id))
        })
        .expect("lane")
        .await
        .expect("job ran");
        assert!(ops.expect("thread_op read on the job's thread"), "an unknown thread recorded no op");
        assert_eq!(fenced.expect("fenced_ops read on the job's thread"), Vec::<String>::new());
    }
}
