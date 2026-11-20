//! The session seams over `mixdog-store` (WP-STORE): the record codec, the `LogWriter` as
//! [`SessionLog`], and the thread open/create paths over the session logs, the blob store and
//! the index.
//!
//! Open: J1 is the bounded log open (`log::open_log`: reverse scan, tail parse and fold); J2
//! reads the UI window (`history_page_on_lane` + positioned frame reads), the open-set
//! records and the prompt-history prefill; decode assembles the session's [`OpenedLog`]. The
//! store's fold already covers the tail, so the opened log carries no tail records.

// Transparent names for existing callback/record shapes; no ownership or ordering change.
type StoredHistoryPage = (Vec<ItemRecord>, Vec<HistoryRow>, bool);

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::MAX_BLOB_BYTES;
use mixdog_rt::CpuInteractive;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::MaintenanceIo;
use mixdog_store::blobs::BlobStore;
use mixdog_store::context::ContextBlobs;
use mixdog_store::context::ContextCursor;
use mixdog_store::context::ContextError;
use mixdog_store::context::ContextPage;
use mixdog_store::context::DecodedContext;
use mixdog_store::context::decode_context;
use mixdog_store::context::finish_context;
use mixdog_store::context::read_context_blobs;
use mixdog_store::encode::EncodeError;
use mixdog_store::encode::Encoded;
use mixdog_store::encode::encode_record;
use mixdog_store::fold::Fold;
use mixdog_store::fsio::IoLane;
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
use mixdog_store::sqlite::DbError;
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
use super::seams::HistoryBefore;
use super::seams::OpenedLog;
use super::seams::RecordCodec;
use super::seams::SessionLog;
use super::seams::StoredOp;
use super::seams::ThreadStore;
use super::seams::WindowRead;
use super::seams::check_turn_read_cancel;
use super::seams::turn_read_cancelled;
use super::turn_draft::RunDraft;

/// UI window rows read at open (P §5.3).
const WINDOW_ROWS: usize = 200;
/// Fork depth followed for the lineage; a deeper chain is a damaged catalog.
const MAX_LINEAGE: usize = 64;

/// [`RecordCodec`] = `encode_record` (FORMAT.md §5.1 with the §4.2 body-slot rule).
pub struct StoreCodec;

impl RecordCodec for StoreCodec {
    fn encode(&self, _lane: &InLane<CpuInteractive>, record: &Record) -> Result<EncodedRecord, CoreError> {
        encode_record(record.clone()).map(EncodedRecord).map_err(|error| match error {
            EncodeError::ItemTooLarge { .. } => CoreError::ItemTooLarge { limit: MAX_BLOB_BYTES },
            other => internal("encode", &other),
        })
    }
}

fn internal(step: &str, error: &dyn std::fmt::Display) -> CoreError {
    CoreError::Internal { incident_id: format!("session-store-{step}: {error}").into() }
}

enum Projecting {
    Frames(u64, Box<Projection>),
    /// Answered once every projection sent before it is committed.
    Flush(tokio::sync::oneshot::Sender<()>),
    /// Answers `reached` once every projection sent before it is committed, then takes nothing more until `release`
    /// resolves (dropped included): a log rewrite changes the files and the rows meanwhile.
    Hold {
        reached: tokio::sync::oneshot::Sender<()>,
        release: tokio::sync::oneshot::Receiver<()>,
    },
}

/// What the forwarding task answers, in the order it was sent.
enum Settled {
    /// The index's answer to the projection of that number and session (its frames are in, and the session's catalog row
    /// with them).
    Projected(u64, String, Result<(), String>),
    /// A flush, reached once every projection sent before it is committed.
    Flushed(tokio::sync::oneshot::Sender<()>),
}

/// Marks the projector stopped when its task ends, and says so once when a panic ended it.
struct StopMark(Arc<std::sync::atomic::AtomicBool>);

impl Drop for StopMark {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        if std::thread::panicking() {
            tracing::error!(
                "the index projector stopped: lists answer what the index holds from now on, and the sessions written since are re-projected at the next start"
            );
        }
    }
}

/// `AppendError::outcome()`: `NotApplied` → `Failed`, `Unknown` → `Indeterminate`.
fn barrier(error: AppendError) -> BarrierError {
    let io_kind: Arc<str> = error.io_kind().into();
    // What the disk said (`EIO: ...`), as Node's refusal names its save's error.
    let cause: Arc<str> = match &error {
        AppendError::BarrierFailed(e) | AppendError::Indeterminate(e) | AppendError::Refused(e) => e.source.to_string().into(),
        _ => io_kind.clone(),
    };
    match error.outcome() {
        Outcome::NotApplied => BarrierError::Failed { io_kind, cause },
        Outcome::Unknown => BarrierError::Indeterminate { io_kind, cause },
    }
}

/// Whether `record` writes a header key the worktree retention reads: a session's favorite or archive mark. A change kept in a
/// blob is not read here and counts as touching.
fn touches_retention(record: &mixdog_store::schema::record::Record) -> bool {
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::Record;
    const KEYS: [&str; 2] = ["favoriteAt", "archivedAt"];
    match record {
        Record::Meta(meta) => match &meta.change {
            Slot::Inline(change) => KEYS.iter().any(|key| change.set.contains_key(*key) || change.unset.iter().any(|unset| unset == key)),
            _ => true,
        },
        Record::Session(start) => match &start.header {
            Slot::Inline(header) => KEYS.iter().any(|key| header.contains_key(*key)),
            _ => true,
        },
        _ => false,
    }
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

/// The session-search copy (the memory service's) a stored session's text is also kept in: an owed session's copy was derived
/// from its log before the rewrite. It is a debt of its own ([`StoreThreads::discharge_search_debt`]): no search answers the
/// session until the copy is confirmed gone, while its reads are answered from its release on.
pub trait SearchCopy: Send + Sync + 'static {
    /// The session's search rows confirmed gone: `Ok(false)` when no copy is kept at all (nothing is to be indexed again),
    /// `Ok(true)` when its rows were deleted; `Err` while that is not confirmed.
    fn invalidate(&self, session: &str) -> futures::future::BoxFuture<'static, Result<bool, String>>;

    /// The session indexed again from its rewritten log after its rows were deleted: `Ok(false)` when it could not be read
    /// now (a fork whose base still owes its rewrite), to be tried again at a later release.
    fn reindex(&self, session: &str) -> futures::future::BoxFuture<'static, Result<bool, String>>;
}

/// The wait before the debts a failed discharge left are tried again.
const SEARCH_DEBT_RETRY: std::time::Duration = std::time::Duration::from_secs(60);

/// The rewrites an earlier process left owed ([`StoreThreads::owe_marks`]), run behind the serving core: what they have done
/// and failed of how many, and the sessions a refused read asked for first.
///
/// `held` is the log reads' copy of the index's withheld state (`mixdog-store` `withheld`, which decides every index read):
/// it holds a session from before the catalog withholds it until after the catalog's release has committed, so it never
/// holds less than the catalog. A log read it lets through is of a session whose release committed, and a release commits
/// only once the log was rewritten and its rows rebuilt from it; the release is never undone in a boot. So the copy can only
/// refuse a read the catalog would answer, never answer one the catalog withholds.
#[derive(Default)]
struct OwedRewrites {
    asked: std::sync::Mutex<std::collections::VecDeque<String>>,
    held: std::sync::RwLock<std::collections::HashSet<String>>,
    /// The sessions whose rewrite failed in this boot: refused until the next start, and told so.
    failed: std::sync::Mutex<std::collections::HashSet<String>>,
    done: std::sync::atomic::AtomicU64,
    total: std::sync::atomic::AtomicU64,
}

impl OwedRewrites {
    /// Boot only ([`StoreThreads::owe_marks`], before anything is served): the one place `held` is added to.
    fn begin(&self, sessions: impl IntoIterator<Item = String>) {
        use std::sync::atomic::Ordering::SeqCst;
        let mut held = self.held.write().unwrap_or_else(std::sync::PoisonError::into_inner);
        held.clear();
        held.extend(sessions);
        self.done.store(0, SeqCst);
        self.total.store(held.len() as u64, SeqCst);
        self.failed.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
    }

    fn holds(&self, session: &str) -> bool {
        self.held.read().unwrap_or_else(std::sync::PoisonError::into_inner).contains(session)
    }

    fn held(&self) -> Vec<String> {
        self.held.read().unwrap_or_else(std::sync::PoisonError::into_inner).iter().cloned().collect()
    }

    /// After the catalog's release of `session` committed.
    fn released(&self, session: &str) {
        self.held.write().unwrap_or_else(std::sync::PoisonError::into_inner).remove(session);
    }

    fn advance(&self) {
        self.done.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    fn fail(&self, session: &str) {
        self.failed.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(session.to_owned());
    }

    /// A read refused `session`: its rewrite goes next.
    fn ask(&self, session: &str) {
        let mut asked = self.asked.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !asked.iter().any(|held| held == session) {
            asked.push_back(session.to_owned());
        }
    }

    fn next_asked(&self) -> Option<String> {
        self.asked.lock().unwrap_or_else(std::sync::PoisonError::into_inner).pop_front()
    }

    /// `coreMigrating` of kind `sensitiveRewrite` while `session`'s rewrite is still to come, `sensitiveRewriteFailed` once it
    /// failed (it is not answered before the next start).
    fn refusal(&self, session: &str) -> CoreError {
        use std::sync::atomic::Ordering::SeqCst;
        let failed = self.failed.lock().unwrap_or_else(std::sync::PoisonError::into_inner).contains(session);
        let kind = if failed { "sensitiveRewriteFailed" } else { "sensitiveRewrite" };
        CoreError::CoreMigrating { kind: kind.into(), done: self.done.load(SeqCst), total: self.total.load(SeqCst) }
    }
}

/// The owed rewrites [`StoreThreads::owe_marks`] found, each session's file numbers of the journaled marks it settles, to be
/// run behind the serving core ([`Self::run`]). Dropped unrun, the sessions stay refused until the next start.
pub struct MarkRewrites {
    threads: Arc<StoreThreads>,
    durability: DurabilityIo,
    progress: Option<Arc<mixdog_store::sqlite::RebuildProgress>>,
    owed: std::collections::BTreeMap<String, Vec<u64>>,
    recovered: Vec<u64>,
}

impl MarkRewrites {
    /// How many sessions owe their rewrite.
    pub fn owed(&self) -> usize {
        self.owed.len()
    }

    /// The next session to rewrite: one a refused read asked for first, else the next in id order.
    fn next(&mut self) -> Option<(String, Vec<u64>)> {
        while let Some(session) = self.threads.owed.next_asked() {
            if let Some(marks) = self.owed.remove(&session) {
                return Some((session, marks));
            }
        }
        self.owed.pop_first()
    }

    /// Each owed session in turn, while the core serves the others: its log rewritten and its rows rebuilt, its search copy
    /// refreshed, the journal told it is settled (durably), and only then is it answered again. `stop` (a quit) ends it
    /// between two sessions: what is done stays done (the journal says so), and the next start goes on with the rest. A
    /// session any step of which fails stays refused, its mark journaled, for the next start; the progress counts it as
    /// failed, and the error names how many.
    pub async fn run(mut self, stop: &mixdog_rt::CancellationToken) -> Result<(), CoreError> {
        use mixdog_core_base::support::on_lane_wait as wait;
        let (Some(marks), Some(journal)) = (self.threads.sensitive.get().cloned(), self.threads.journal.get().cloned()) else { return Ok(()) };
        let never = mixdog_rt::CancellationToken::new();
        let (mut failed, mut first) = (0usize, None);
        loop {
            if stop.is_cancelled() {
                return Ok(());
            }
            let Some((session, settles)) = self.next() else { break };
            match self.settle_one(&marks, &journal, stop, &session, settles).await {
                Ok(()) => {
                    self.threads.owed.advance();
                    if let Some(progress) = &self.progress {
                        progress.advance();
                    }
                }
                Err(_) if stop.is_cancelled() => return Ok(()),
                Err(error) => {
                    tracing::warn!(thread = %session, "an owed sensitive rewrite failed; the session stays unread until the next start: {error:?}");
                    self.threads.owed.fail(&session);
                    if let Some(progress) = &self.progress {
                        progress.fail();
                    }
                    failed += 1;
                    first.get_or_insert(error);
                }
            }
        }
        if let Some(error) = first {
            return Err(internal("sensitive-marks", &format!("{failed} session(s) still owe their rewrite (first: {error:?})")));
        }
        let (journal, recovered) = (journal.clone(), std::mem::take(&mut self.recovered));
        wait(self.threads.maintenance, &never, move |_lane| journal.forget_recovered(recovered)).await?;
        Ok(())
    }

    /// One session's steps, each only after the one before it held.
    #[allow(clippy::disallowed_methods, reason = "the journal's files are written inside its maintenance lane job")]
    async fn settle_one(
        &self,
        marks: &Arc<dyn super::seams::SensitiveMarks>,
        journal: &Arc<super::mark_journal::MarksOnDisk>,
        stop: &mixdog_rt::CancellationToken,
        session: &str,
        settles: Vec<u64>,
    ) -> Result<(), CoreError> {
        use mixdog_core_base::support::on_lane_wait as wait;
        let threads = &self.threads;
        let never = mixdog_rt::CancellationToken::new();
        // The search copy's debt is on disk before anything can release the session: from the release on, no search
        // answers its old copy, whenever the process ends.
        {
            let (journal, id) = (journal.clone(), session.to_owned());
            wait(threads.maintenance, &never, move |_lane| journal.owe_search(&id)).await?.map_err(|error| internal("sensitive-marks-journal", &error))?;
        }
        let id = ThreadId::from(session);
        let mut settles = Some(settles);
        loop {
            // The log rewritten and the rows rebuilt from it, still withheld.
            let version = threads.rewrite_owed(self.durability, stop, marks, session).await?;
            // The settlement on disk before the release: a crash after the release does not rewrite the session again, and a
            // failed write leaves it withheld (refused and told failed), never readable and counted failed. A crash between
            // the two leaves the catalog withholding a settled session: the next start's withholding, which owes it
            // nothing, drops it.
            let (journal, held, owed) = (journal.clone(), session.to_owned(), settles.take());
            wait(threads.maintenance, &never, move |_lane| {
                if let Some(owed) = owed {
                    journal.settled(&held, &owed)?;
                }
                journal.applied(&held, version);
                Ok::<(), String>(())
            })
            .await?
            .map_err(|error| internal("sensitive-marks-journal", &error))?;
            // A mark that arrived since the rewrite keeps the session withheld for another round.
            if marks.version(&id) != version {
                if stop.is_cancelled() {
                    // Settled for what it was rewritten for; the newer mark is journaled and owed by the next start.
                    return Err(internal("sensitive-marks", &"stopped before a newer mark's round"));
                }
                continue;
            }
            // The catalog first, then the log reads' gate (`OwedRewrites`).
            threads.index.release_withheld(session).await.map_err(|error| internal("sensitive-marks-release", &error))?;
            threads.owed.released(session);
            // No lock ties a mark to this release. A mark that landed after the check above is a mark on a session about to
            // be released: the thread its carried listener opens is refused while the gate stands, and that task opens it
            // again until it is released (`SessionDirectory::carried`), then rewrites it as a released session is for any mark.
            break;
        }
        threads.search_debt.notify_waiters();
        Ok(())
    }
}

/// One running rewrite; ends when dropped.
struct Rewriting(Arc<Rewrites>);

impl Drop for Rewriting {
    fn drop(&mut self) {
        self.0.running.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        self.0.done.notify_waiters();
    }
}

fn writer_lost() -> BarrierError {
    BarrierError::Indeterminate { io_kind: "writerLost".into(), cause: "writerLost".into() }
}

/// A test build's hold at a named point of a log's barrier, run on the barrier's own lane thread: of its sensitive rewrite,
/// `planned` once the plan has read the log and `held` while the rewrite holds the reads; `appended` once the batch is in
/// the log and before its projection is sent. Compiled only into a build that asks for `crash-gates`.
#[cfg(feature = "crash-gates")]
pub mod rewrite_holds {
    type Hold = std::sync::Arc<dyn Fn() + Send + Sync>;
    static HOLDS: std::sync::Mutex<Vec<(&'static str, Hold)>> = std::sync::Mutex::new(Vec::new());

    /// Runs `hold` whenever a rewrite reaches `point`.
    pub fn set(point: &'static str, hold: impl Fn() + Send + Sync + 'static) {
        HOLDS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((point, std::sync::Arc::new(hold)));
    }

    pub(super) fn at(point: &str) {
        let holds: Vec<Hold> =
            HOLDS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().filter(|(p, _)| *p == point).map(|(_, h)| h.clone()).collect();
        for hold in holds {
            hold();
        }
    }
}

#[cfg(not(feature = "crash-gates"))]
mod rewrite_holds {
    pub(super) fn at(_point: &str) {}
}

/// What the row reads of a thread take from its opened log, and the logs it was folded from at their versions.
pub(super) struct LogShape {
    /// The thread's own log, then each base's.
    logs: Vec<String>,
    /// `log_epoch::settled` of each of `logs` at which this shape was taken; none when one of them was being written.
    versions: Vec<u64>,
    /// `log_epoch::shape_settled` of each of `logs` when they were read.
    shapes: Vec<u64>,
    lineage: Arc<Vec<LineageLevel>>,
    base_cut: Option<u64>,
    history_rev: u64,
}

impl LogShape {
    /// Nothing was written to the logs since the shape was taken.
    pub(super) fn is_current(&self) -> bool {
        self.logs.len() == self.versions.len() && self.logs.iter().zip(&self.versions).all(|(log, v)| mixdog_store::log_epoch::settled(log) == Some(*v))
    }

    /// Whatever was written to the logs since they were read left this shape as it is.
    pub(super) fn stands(&self) -> bool {
        self.logs.len() == self.shapes.len() && self.logs.iter().zip(&self.shapes).all(|(log, v)| mixdog_store::log_epoch::shape_settled(log) == Some(*v))
    }

    /// Both shapes are of one read of the logs.
    #[cfg(test)]
    pub(super) fn of_one_read(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.lineage, &other.lineage)
    }

    /// A shape read from no log, which nothing written changes.
    #[cfg(test)]
    pub(super) fn of_no_log() -> Arc<Self> {
        Arc::new(Self { logs: Vec::new(), versions: Vec::new(), shapes: Vec::new(), lineage: Arc::default(), base_cut: None, history_rev: 0 })
    }
}

/// The most rows one record's ids are searched back over (`Ids::next` numbers a record's rows).
const ROWS_PER_RECORD: u128 = 64;

/// The item ids of stored records that can show a row under `shown`, a client's row id: the record's own id (the first row
/// shows it), the record that numbers its later rows `<iid>:<n>` or `<iid>:model:<at>`, or `itm_` + its 128-bit id plus the row's
/// position. A row of another record can show `shown` only as a submission id, which the index looks up as an alias.
fn anchor_iids(shown: &str) -> Vec<String> {
    let mut ids = vec![shown.to_owned()];
    ids.extend(shown.match_indices(':').filter(|(at, _)| *at > 0).map(|(at, _)| shown[..at].to_owned()));
    if let Some(bits) = shown.strip_prefix("itm_").filter(|hex| hex.len() == 32).and_then(|hex| u128::from_str_radix(hex, 16).ok()) {
        ids.extend((1..ROWS_PER_RECORD).map(|back| format!("itm_{:032x}", bits.wrapping_sub(back))));
    }
    ids
}

/// The window rows a compaction took out of the context, which a restored window still shows (1.4.5 `archived: true`): the model
/// rows it dropped, and the display rows (a turn's end) of a turn none of whose messages is left.
fn archived_ordinals(rows: &[HistoryRow]) -> Vec<u64> {
    use std::collections::HashSet;
    let turn_of = |row: &HistoryRow| row.turn.clone();
    let gone: HashSet<String> = rows.iter().filter(|row| row.model && row.archived).filter_map(turn_of).collect();
    let live: HashSet<String> = rows.iter().filter(|row| row.model && !row.archived).filter_map(turn_of).collect();
    rows.iter()
        .filter(|row| match (row.model, &row.turn) {
            (true, _) => row.archived,
            (false, Some(turn)) => gone.contains(turn) && !live.contains(turn),
            (false, None) => false,
        })
        .map(|row| row.ordinal)
        .collect()
}

/// Context rows read per page.
const CONTEXT_PAGE_ROWS: usize = 200;

/// A model-context read between its lane steps.
struct ContextState {
    lineage: Vec<LineageLevel>,
    cut: Option<u64>,
    first: bool,
    at: ContextAt,
    /// The read gate's generation its first job read under.
    generation: u64,
    /// The context's first rows the read leaves out (a restart leaves out as many).
    skip: usize,
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

/// J2's reads, handed to decode.
struct Window {
    window: Vec<(u64, ItemRecord)>,
    archived: Vec<u64>,
    dividers: Vec<super::seams::WindowDivider>,
    has_older: bool,
    prompts: Vec<String>,
    runs: Vec<(u64, mixdog_store::schema::record::RunRecord)>,
    drafts: Vec<(String, RunDraft)>,
    approvals: Vec<(u64, mixdog_store::schema::record::ApprovalRecord)>,
    queue: Vec<(u64, mixdog_store::schema::record::QueueRecord)>,
}

fn unexpected(what: &str) -> CoreError {
    internal("open-set", &format!("frame is not a {what} record"))
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
        Self { limits: mixdog_core_base::feed::FeedLimits { ring_bytes: bytes(limits.ring_bytes), max_snapshot_bytes: bytes(limits.max_snapshot_bytes) }, cpu }
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
mod archived_tests {
    use super::*;
    use mixdog_store::schema::record::Form;

    fn row(ordinal: u64, turn: &str, model: bool, archived: bool) -> HistoryRow {
        HistoryRow {
            session: "sess_a".into(),
            ordinal,
            iid: format!("i{ordinal}"),
            turn: Some(turn.into()),
            form: if model { Form::Message } else { Form::Display },
            model,
            pos: mixdog_store::schema::checkpoint::FramePos { ordinal, file_no: 0, offset: 0 },
            frame_len: 0,
            amend: None,
            archived,
            dropped_text: archived,
            dropped_calls: Vec::new(),
            kept: Vec::new(),
            model_switches: Vec::new(),
        }
    }

    /// A restored window marks the rows a compaction took out: its model rows, and the end row of a turn none of whose messages
    /// is left; a turn that kept a message stays live whole.
    #[test]
    fn a_window_marks_the_rows_a_compaction_took_out_and_the_end_of_a_turn_left_with_nothing() {
        let rows = [
            row(1, "t1", true, true),
            row(2, "t1", false, false),
            row(3, "t2", true, true),
            row(4, "t2", true, false),
            row(5, "t2", false, false),
            row(6, "t3", true, false),
            row(7, "t3", false, false),
        ];
        assert_eq!(archived_ordinals(&rows), vec![1, 2, 3]);
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
        Projection { session: session.into(), frames: Vec::new(), head: Arc::new(head) }
    }

    /// A projector whose task died (a panic while projecting) leaves its count of queued projections behind; a list must not wait
    /// on it from then on: the wait that was pending ends, and no later list gets one.
    #[tokio::test]
    async fn a_projector_that_died_is_not_waited_on() {
        let projector = Projector::spawn_with(|_| async { Ok(async { panic!("the projection panicked") }) });
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
            async move { Ok(async move { if session == "sess_bad" { Err("disk I/O error".to_owned()) } else { Ok(()) } }) }
        });
        projector.send(empty_projection("sess_bad"));
        projector.send(empty_projection("sess_ok"));
        let failed = |result: Result<(), CoreError>| match result {
            Err(CoreError::Internal { incident_id }) => {
                assert!(incident_id.contains("index-write-failed") && incident_id.contains("sess_bad"), "{incident_id}")
            }
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
                async move { Ok(async move { if refuse { Err("disk I/O error".to_owned()) } else { Ok(()) } }) }
            }
        });
        projector.send(empty_projection("sess_bad"));
        assert!(projector.indexed("sess_bad").await.is_err(), "the refused write");
        projector.send(empty_projection("sess_bad"));
        projector.indexed("sess_bad").await.expect("the index holds the session again");
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
    /// The projector queues every projection sent at the index writer, in barrier order, without waiting for the commits of those
    /// before it (so the writer commits them in one transaction), and a list's wait still ends only once each one is committed.
    #[tokio::test]
    async fn the_projections_sent_are_all_queued_at_the_index_before_the_first_is_committed() {
        let queued = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (commit, committed) = tokio::sync::watch::channel(false);
        let projector = Projector::spawn_with({
            let queued = queued.clone();
            move |projection: Projection| {
                queued.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(projection.session);
                let mut committed = committed.clone();
                async move { Ok(async move { committed.wait_for(|done| *done).await.map(drop).map_err(|error| error.to_string()) }) }
            }
        });
        let sessions = ["sess_a", "sess_b", "sess_c"];
        for session in sessions {
            projector.send(empty_projection(session));
        }
        let mut wait = projector.settle().expect("the projections are pending");
        crate::session::testing::awaiting(|| "every projection sent to be queued at the index".to_owned(), async {
            while queued.lock().unwrap_or_else(std::sync::PoisonError::into_inner).len() < sessions.len() {
                tokio::task::yield_now().await;
            }
        })
        .await;
        assert_eq!(*queued.lock().unwrap_or_else(std::sync::PoisonError::into_inner), sessions, "queued in barrier order");
        assert!(futures::poll!(wait.as_mut()).is_pending(), "the list's wait ended before the commits");
        assert!(projector.settle().is_some(), "none is committed yet");
        commit.send_replace(true);
        wait.await;
        assert!(projector.settle().is_none(), "the index holds them all");
    }
    /// The exact class's wait: behind a projection that never ends it still waits one tick before
    /// [`FENCE_BOUND`](super::super::thread_list::FENCE_BOUND), and at the bound it fails, saying the index is behind; it never goes
    /// on to read.
    #[tokio::test(start_paused = true)]
    async fn an_exact_read_behind_a_stuck_projection_fails_at_the_bound() {
        let bound = super::super::thread_list::FENCE_BOUND;
        let _clock = crate::session::testing::HeldClock::hold();
        let projector = Projector::spawn_with(|_| std::future::ready(Ok(std::future::pending::<Result<(), String>>())));
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
        let mut stuck = Projector::spawn_with(|_| std::future::ready(Ok(std::future::pending::<Result<(), String>>())));
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

#[cfg(test)]
mod anchor_tests {
    use super::anchor_iids;
    use crate::session::transcript::transcript_rows::Ids;

    /// Every id a record's rows show names the record back: `Ids` numbers a live record's later rows from its 128-bit id, and
    /// another record's by `<iid>:<n>`.
    #[test]
    fn a_rows_id_names_its_records_iid() {
        for iid in ["itm_00000000000000000000000000000fff", "itm_ffffffffffffffffffffffffffffffff", "hist_ab12"] {
            let mut ids = Ids::new(iid);
            for part in 1..=40 {
                let shown = ids.next();
                assert!(anchor_iids(&shown).iter().any(|candidate| candidate == iid), "{iid} row {part} shows {shown}");
            }
        }
        assert!(anchor_iids("itm_0000000000000000000000000000000a:model:12").contains(&"itm_0000000000000000000000000000000a".to_owned()));
    }
}

/// [`super::seams::TurnIngest`] over the session-search writer; `None` when the process has no memory runtime.
pub struct SessionSearchTurns(pub Option<Arc<mixdog_services::memory::session_search::ingest::SessionSearchIngest>>);
impl SessionSearchTurns {
    /// Over the memory service's one session-search writer (`SessionSearchIngest::new(db,
    /// sensitive)`, the same one `forgetSessionSearch` and the backfill use).
    pub fn new(ingest: Option<Arc<mixdog_services::memory::session_search::ingest::SessionSearchIngest>>) -> Self {
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
        if let Some(ingest) = &self.0 {
            ingest.ingest_turn(search_session(id, header, messages));
        }
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
    /// The sessions one of whose projections the index never took. A later projection restores the session's head and
    /// not the rows of the one that failed: those stay out of the index until the next start re-projects the session.
    rows_lost: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    /// The numbers of the projections queued or running that carry a favorite or archive mark write.
    marking: Arc<std::sync::Mutex<std::collections::HashSet<u64>>>,
    /// The sessions whose mark write the index failed to take and no later projection of the session has restored: the
    /// index holds an older mark for them, so a read derived from the marks cannot be trusted while any is here.
    marks_lost: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    /// Advances whenever what [`marks_lost`](Self::marks_lost) says can have changed: every settlement of a mark-carrying
    /// projection, and a success that restored a lost session. A read of the marks is valid only if it did not move across it.
    marks_epoch: Arc<std::sync::atomic::AtomicU64>,
    /// A test's switch: the next projection is refused by the index.
    refuse_next: Arc<std::sync::atomic::AtomicBool>,
}
impl Projector {
    /// Starts the forwarding task on the current Tokio runtime.
    pub fn spawn(index: SqliteStore) -> Self {
        // A failed projection leaves the session dirty; reconcile re-projects it from its log at the next start. The open's own
        // reconcile needs no wait here: every way into the index waits for it and answers its failure (`SqliteStore`'s gate).
        let refuse_next = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut projector = Self::spawn_with({
            let refuse_next = refuse_next.clone();
            move |projection| {
                let index = index.clone();
                let refuse_next = refuse_next.clone();
                async move {
                    #[cfg(any(test, feature = "test-support"))]
                    if refuse_next.swap(false, std::sync::atomic::Ordering::SeqCst) {
                        return Err("the index refused the projection".to_owned());
                    }
                    let _ = &refuse_next;
                    let committed = index.queue_projection(projection).await.map_err(|error| error.to_string())?;
                    Ok(async move { committed.await.map_err(|error| error.to_string()) })
                }
            }
        });
        projector.refuse_next = refuse_next;
        projector
    }

    /// The forwarding task over `project`, which queues a projection at the index writer and resolves with the wait for its
    /// commit. A projection is queued, in barrier order, as soon as it is sent, without waiting for the commits of those before it,
    /// so the writer commits every projection queued meanwhile in one transaction (one sync of the index for them, not one each);
    /// their answers are taken in barrier order.
    fn spawn_with<P, Q, C>(mut project: P) -> Self
    where
        P: FnMut(Projection) -> Q + Send + 'static,
        Q: std::future::Future<Output = Result<C, String>> + Send,
        C: std::future::Future<Output = Result<(), String>> + Send + 'static,
    {
        let (queue, mut rx) = mpsc::unbounded_channel::<Projecting>();
        let pending = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let lost: Arc<std::sync::Mutex<std::collections::HashMap<String, u64>>> = Arc::default();
        let marking: Arc<std::sync::Mutex<std::collections::HashSet<u64>>> = Arc::default();
        let marks_lost: Arc<std::sync::Mutex<std::collections::HashSet<String>>> = Arc::default();
        let rows_lost: Arc<std::sync::Mutex<std::collections::HashSet<String>>> = Arc::default();
        let rows_lost_here = rows_lost.clone();
        let (done_count, mark, failed) = (pending.clone(), StopMark(stopped.clone()), lost.clone());
        let marks_epoch: Arc<std::sync::atomic::AtomicU64> = Arc::default();
        let (marking_here, marks_lost_here, epoch_here) = (marking.clone(), marks_lost.clone(), marks_epoch.clone());
        #[cfg(feature = "replay-settled")]
        {
            let pending = pending.clone();
            super::replay_settled::watch(move || {
                (pending.load(std::sync::atomic::Ordering::SeqCst) != 0).then_some("the index projector has a projection in flight")
            });
        }
        tokio::spawn(async move {
            use futures::StreamExt;
            let _mark = mark;
            let answer = |settled: Settled| match settled {
                Settled::Projected(number, session, result) => {
                    let marked = marking_here.lock().unwrap_or_else(|e| e.into_inner()).remove(&number);
                    match result {
                        Err(error) => {
                            tracing::error!(%session, %error, "the index did not take a projection: the session is re-projected at the next start");
                            if marked {
                                let mut lost_marks = marks_lost_here.lock().unwrap_or_else(|e| e.into_inner());
                                epoch_here.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                                lost_marks.insert(session.clone());
                                drop(lost_marks);
                            }
                            rows_lost_here.lock().unwrap_or_else(|e| e.into_inner()).insert(session.clone());
                            failed.lock().unwrap_or_else(|e| e.into_inner()).entry(session).or_insert(number);
                        }
                        // A later projection carries the session's whole head (its header), so the index holds the header
                        // writes again: the header waits stop failing.
                        Ok(()) => {
                            // The epoch moves before the loss is cleared, both under the set's lock: a reader never sees the
                            // loss gone with the epoch it captured before the restoring write.
                            let mut lost_marks = marks_lost_here.lock().unwrap_or_else(|e| e.into_inner());
                            if marked || lost_marks.contains(&session) {
                                epoch_here.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            }
                            lost_marks.remove(&session);
                            drop(lost_marks);
                            failed.lock().unwrap_or_else(|e| e.into_inner()).remove(&session);
                        }
                    }
                    done_count.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    #[cfg(feature = "replay-settled")]
                    super::replay_settled::changed();
                }
                Settled::Flushed(done) => drop(done.send(())),
            };
            // The projections queued at the writer and the flushes sent after them, answered in the order they were sent.
            let mut committing: futures::stream::FuturesOrdered<futures::future::BoxFuture<'static, Settled>> = futures::stream::FuturesOrdered::new();
            loop {
                tokio::select! {
                    biased;
                    Some(settled) = committing.next(), if !committing.is_empty() => answer(settled),
                    msg = rx.recv() => match msg {
                        None => break,
                        Some(Projecting::Frames(number, projection)) => {
                            let session = projection.session.clone();
                            committing.push_back(match project(*projection).await {
                                Ok(commit) => Box::pin(async move { Settled::Projected(number, session, commit.await) }),
                                Err(error) => Box::pin(std::future::ready(Settled::Projected(number, session, Err(error)))),
                            });
                        }
                        Some(Projecting::Flush(done)) => committing.push_back(Box::pin(std::future::ready(Settled::Flushed(done)))),
                        Some(Projecting::Hold { reached, release }) => {
                            while let Some(settled) = committing.next().await {
                                answer(settled);
                            }
                            let _ = reached.send(());
                            drop(release.await);
                            done_count.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                        }
                    },
                }
            }
        });
        Self {
            queue,
            pending,
            stopped,
            bound: super::thread_list::FENCE_BOUND,
            sent: Arc::default(),
            lost,
            rows_lost,
            marking,
            marks_lost,
            marks_epoch,
            refuse_next: Arc::default(),
        }
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
        self.send_marking(projection, false);
    }

    /// [`send`](Self::send); `marks`: the projection carries a favorite or archive mark write, which a failed projection leaves
    /// out of the index ([`marks_lost`](Self::marks_lost)).
    fn send_marking(&self, projection: Projection, marks: bool) {
        // Counted before it is queued, so a reader that follows the barrier's ack sees it pending until the index holds it.
        self.pending.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let number = self.sent.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        if marks {
            self.marking.lock().unwrap_or_else(|e| e.into_inner()).insert(number);
        }
        if let Err(unsent) = self.queue.send(Projecting::Frames(number, Box::new(projection))) {
            self.pending.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            self.marking.lock().unwrap_or_else(|e| e.into_inner()).remove(&number);
            if let Projecting::Frames(_, projection) = unsent.0 {
                self.rows_lost.lock().unwrap_or_else(|e| e.into_inner()).insert(projection.session.clone());
            }
        }
    }

    /// Whether the index lacks rows of `session` that its log holds: one of its projections sent so far was never taken.
    /// Asked after [`caught_up`](Self::caught_up), it answers for every batch acknowledged before that wait.
    fn rows_lost(&self, session: &str) -> bool {
        self.rows_lost.lock().unwrap_or_else(|e| e.into_inner()).contains(session)
    }

    /// Whether a mark write the index failed to take is still missing from it: the sessions, until a later projection of each
    /// restores its head.
    fn marks_lost(&self) -> Vec<String> {
        self.marks_lost.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
    }

    fn marks_epoch(&self) -> u64 {
        self.marks_epoch.load(std::sync::atomic::Ordering::SeqCst)
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
/// [`SessionLog`] over a `LogWriter` (which places checkpoints and rotates by itself).
struct StoreLog {
    /// `None` when the log could not be reopened after a rewrite: the next start settles it (`log_rewrite::recover`).
    writer: Option<LogWriter>,
    projector: Projector,
    redaction: Option<Redaction>,
    /// The store's retention version: moved by every batch this log commits that sets or clears a sidebar retention mark.
    retention: Arc<std::sync::atomic::AtomicU64>,
    /// The thread this log is of.
    thread: String,
    /// The store's kept context lengths: this log's batches run inside them.
    context_lens: Arc<super::context_lens::ContextLens>,
}
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
        let index = self.index.clone();
        let mut index_step = || {
            let rewrite = mixdog_store::sqlite::Rewritten { data: self.data.clone(), session: session.clone(), dirty: DirtyMark::Set };
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
                Ok(false) => redaction.seen = version,
                Ok(true) => {
                    if redaction.settle(lane, &mut self.writer) {
                        redaction.seen = version;
                    }
                }
                Err(error) => {
                    tracing::warn!(thread = %session, "the sensitive rewrite of the log could not be planned; it is tried again at the next barrier: {error}")
                }
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
                *out = mixdog_store::encode::encode_record(next).map_err(|e| BarrierError::failed(&format!("encode:{e}")))?;
            }
        }
        Ok(encoded)
    }
}
impl SessionLog for StoreLog {
    fn commit(&mut self, lane: &InLane<DurabilityIo>, batch: &[CommitRecord]) -> Result<Vec<u64>, BarrierError> {
        // Entered before the log is touched: a rewind is in the log, and in what a read takes from it, before its
        // projection is on its way to the index.
        let entered = self.context_lens.batch(&self.thread);
        self.redact_written(lane);
        let encoded = self.stored_batch(batch)?;
        let writer = self.writer.as_mut().ok_or_else(writer_lost)?;
        let ack = writer.append_barrier(lane, encoded).map_err(barrier)?;
        rewrite_holds::at("appended");
        let ordinals = ack.positions.iter().map(|p| p.ordinal).collect();
        // The projection is registered before the version moves: a reader that sees the new version then sees the projection
        // pending (or in the index), so a scan keyed by that version never holds index contents older than the write. After the
        // batch is durable, so a scan that read before it is never the one a later ask is served.
        let marks = batch.iter().any(|c| touches_retention(&c.record));
        let growth = super::context_lens::Growth::of(&ack.projection);
        entered.stored(growth, || self.projector.send_marking(ack.projection, marks));
        if marks {
            self.retention.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            rewrite_holds::at("retention-moved");
        }
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
    /// The rewrites an earlier process left owed, run behind the serving core ([`Self::owe_marks`]).
    owed: Arc<OwedRewrites>,
    /// Told when a rewritten session is released: its search-copy debt can be discharged ([`Self::discharge_search_debt`]).
    search_debt: tokio::sync::Notify,
    retention: Arc<std::sync::atomic::AtomicU64>,
    /// What the reads of a thread's rows take from its opened log, by thread, with the stamp of the log it was read from
    /// ([`StoreThreads::shape`]).
    shapes: std::sync::Mutex<std::collections::HashMap<String, Arc<LogShape>>>,
    /// The length of each thread's model context, followed in memory through the thread's own commits.
    context_lens: Arc<super::context_lens::ContextLens>,
    /// The header members read of a stored thread, by thread and by the list of members asked for, with the version of
    /// its log they were read at ([`ThreadStore::read_header_fields`]).
    picked: std::sync::Mutex<std::collections::HashMap<(String, usize, usize), PickedHeader>>,
    /// A test's pause between a marks read's snapshot and its check.
    #[cfg(any(test, feature = "test-support"))]
    after_snapshot: std::sync::Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
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
            owed: Arc::default(),
            search_debt: tokio::sync::Notify::new(),
            retention: Arc::default(),
            shapes: std::sync::Mutex::default(),
            context_lens: Arc::default(),
            picked: std::sync::Mutex::default(),
            #[cfg(any(test, feature = "test-support"))]
            after_snapshot: std::sync::Mutex::default(),
        }
    }

    /// Holds the index projections (as a rewrite does), for a test of what waits on them.
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build")
    )]
    pub(super) fn hold_index(&self) -> (tokio::sync::oneshot::Receiver<()>, tokio::sync::oneshot::Sender<()>) {
        self.projector.hold()
    }

    /// The sessions whose favorite or archive write the index did not take (see [`Projector::marks_lost`]).
    /// Every stored session's row as the index holds the marks, as one observation: valid only for the mark-projection state it
    /// was read against. Once the index holds every write acknowledged so far, the rows are read; an `Err` (never cached by the
    /// caller, the next ask reads again) when a mark write the index refused is still missing from them, or when that state
    /// moved while the rows were read (a settlement or a restoring write between the snapshot and the check).
    pub(super) async fn marked_catalog(&self) -> Result<Vec<mixdog_store::sqlite::lead::LeadRow>, String> {
        use super::thread_list::ListFence as _;
        if let Some(wait) = self.pending() {
            wait.await;
        }
        let epoch = self.projector.marks_epoch();
        let rows = self.index.marked_rows().await.map_err(|error| error.to_string())?;
        #[cfg(any(test, feature = "test-support"))]
        {
            let hold = self.after_snapshot.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(hold) = hold {
                hold();
            }
        }
        let lost = self.projector.marks_lost();
        if let Some(first) = lost.first() {
            return Err(format!(
                "the index did not take the favorite or archive marks of {} session(s) (first: {first}); they are read again once a later write of the session is indexed",
                lost.len()
            ));
        }
        if self.projector.marks_epoch() != epoch {
            return Err("the marks' projections settled while they were read; they are read again".to_owned());
        }
        Ok(rows)
    }

    /// The next projection is refused by the index, as a full disk would.
    #[cfg(test)]
    pub(super) fn refuse_next_projection(&self) {
        self.projector.refuse_next.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// The read gate, shared for one lane job of a read of `id` (see [`ReadGate`]). Taken after any wait on the projector: a
    /// rewrite holds the projector while it waits for the gate. Every read of a thread's log or rows takes it first, so a
    /// thread that still owes a sensitive rewrite from an earlier process is refused here ([`Self::owes_nothing`]).
    fn read_gate(&self, id: &ThreadId) -> Result<std::sync::RwLockReadGuard<'_, u64>, CoreError> {
        self.owes_nothing(id.as_str())?;
        Ok(self.gate.read().unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    /// `coreMigrating` while `session` owes the rewrite [`Self::owe_marks`] found: nothing of its log is read before the
    /// rewrite is done. The refusal never waits (a lane job waiting on the rewrite could hold the lane the rewrite needs);
    /// it asks the rewrites to take `session` next, so a retry soon reads it.
    fn owes_nothing(&self, session: &str) -> Result<(), CoreError> {
        if !self.owed.holds(session) {
            return Ok(());
        }
        self.owed.ask(session);
        Err(self.owed.refusal(session))
    }

    /// Tells the search-debt discharge a session was released, as a rewrite's release does.
    #[cfg(test)]
    pub(super) fn tell_released(&self) {
        self.search_debt.notify_waiters();
    }

    /// The sessions no search may answer: those still owing their sensitive rewrite, and those whose search copy (text from
    /// before the rewrite) is not yet confirmed gone.
    pub fn search_withheld(&self) -> Vec<String> {
        // The copy never holds less than the catalog, and a session's debt is on disk before its release.
        let mut hidden = self.owed.held();
        if let Some(journal) = self.journal.get() {
            hidden.extend(journal.search_owed());
        }
        hidden
    }

    /// Discharges the search-copy debts the journal holds (those an earlier boot left included) through `copy`, as each
    /// rewritten session is released, until `stop`. A debt leaves the journal only once `copy` confirms its rows gone; one
    /// that is not confirmed is tried again after a while, and a boot that runs no discharge (no memory runtime) keeps it.
    /// A session whose rows were deleted is then indexed again; one that cannot be read yet (a fork whose base still owes
    /// its rewrite) stays pending and is tried again at each later release (a restart's backfill finds it unstamped).
    #[allow(clippy::disallowed_methods, reason = "the journal's file is removed inside its maintenance lane job")]
    pub async fn discharge_search_debt(self: Arc<Self>, copy: Arc<dyn SearchCopy>, stop: mixdog_rt::CancellationToken) {
        use mixdog_core_base::support::on_lane_wait as wait;
        let Some(journal) = self.journal.get().cloned() else { return };
        let mut reindex: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        loop {
            let added = self.search_debt.notified();
            tokio::pin!(added);
            added.as_mut().enable();
            let mut unconfirmed = false;
            for session in journal.search_owed() {
                if stop.is_cancelled() {
                    return;
                }
                // Still owing its rewrite: it is told again once released.
                if self.owed.holds(&session) {
                    continue;
                }
                // A quit does not wait out the copy (a lock it waits on, up to the statement timeout): the debt stays on
                // disk and the next start discharges it.
                let invalidated = tokio::select! {
                    invalidated = copy.invalidate(&session) => invalidated,
                    () = stop.cancelled() => return,
                };
                let confirmed = match invalidated {
                    Ok(deleted) => {
                        let (journal, id) = (journal.clone(), session.clone());
                        wait(self.maintenance, &mixdog_rt::CancellationToken::new(), move |_lane| journal.search_discharged(&id))
                            .await
                            .map_err(|error| format!("{error:?}"))
                            .and_then(|discharged| discharged)
                            .map(|()| deleted)
                    }
                    Err(error) => Err(error),
                };
                match confirmed {
                    // Only rows that were deleted are derived again: no copy kept, nothing is opened for one.
                    Ok(deleted) => {
                        if deleted {
                            reindex.insert(session);
                        }
                    }
                    Err(error) => {
                        tracing::warn!(thread = %session, "the search copy of a rewritten session is not confirmed gone; no search answers it meanwhile: {error}");
                        unconfirmed = true;
                    }
                }
            }
            for session in reindex.clone() {
                if stop.is_cancelled() {
                    return;
                }
                if self.owed.holds(&session) {
                    continue;
                }
                // Cut short by a quit: its stamp was deleted with its rows, so the next start's backfill indexes it.
                let reindexed = tokio::select! {
                    reindexed = copy.reindex(&session) => reindexed,
                    () = stop.cancelled() => return,
                };
                match reindexed {
                    Ok(true) => {
                        reindex.remove(&session);
                    }
                    // Not readable yet (busy, or a base still owed): tried again at a later release or on the timer.
                    Ok(false) => {}
                    Err(error) => {
                        tracing::warn!(thread = %session, "a rewritten session's search copy was not derived again; it is tried again: {error}");
                        unconfirmed = true;
                    }
                }
            }
            // A re-index still pending is tried again on a timer too, not only at a later release (none may come).
            let retry = async {
                if unconfirmed || !reindex.is_empty() {
                    let _ = mixdog_rt::time::timeout(SEARCH_DEBT_RETRY, std::future::pending::<()>()).await;
                } else {
                    std::future::pending::<()>().await;
                }
            };
            tokio::select! {
                () = added => {}
                () = retry => {}
                () = stop.cancelled() => return,
            }
        }
    }

    /// At start, before any thread is served: the marks this data dir saved are known again, and every session that owes a
    /// rewrite for one is withheld (no read of its log or rows answers until its rewrite is done); then the rewrites, all of
    /// them. The composition does the two apart ([`Self::owe_marks`], then [`MarkRewrites::run`] behind the serving core).
    pub async fn settle_marks(
        self: &Arc<Self>,
        durability: DurabilityIo,
        progress: Option<&Arc<mixdog_store::sqlite::RebuildProgress>>,
    ) -> Result<(), CoreError> {
        self.owe_marks(durability, progress).await?.run(&mixdog_rt::CancellationToken::new()).await
    }

    /// Before any thread is served: the journaled marks restored, and each session still owing its rewrite withheld from every
    /// read (the index's content of it included) until [`MarkRewrites::run`] has rewritten it. A session a run before already
    /// rewrote for a mark (the journal names it settled) owes that mark nothing. The rewrites owed are added to `progress`,
    /// which they advance as they run.
    pub async fn owe_marks(
        self: &Arc<Self>,
        durability: DurabilityIo,
        progress: Option<&Arc<mixdog_store::sqlite::RebuildProgress>>,
    ) -> Result<MarkRewrites, CoreError> {
        let mut owed =
            MarkRewrites { threads: self.clone(), durability, progress: progress.cloned(), owed: std::collections::BTreeMap::new(), recovered: Vec::new() };
        let (Some(marks), Some(journal)) = (self.sensitive.get(), self.journal.get()) else {
            // No marks bound, so none is owed and the log reads refuse nothing: the catalog agrees.
            self.index.withhold(Vec::new()).await.map_err(|e| internal("sensitive-marks-withhold", &e))?;
            return Ok(owed);
        };
        use mixdog_core_base::support::on_lane_wait as wait;
        let never = mixdog_rt::CancellationToken::new();
        let loaded = {
            let journal = journal.clone();
            wait(self.maintenance, &never, move |_lane| journal.load()).await?
        }
        .map_err(|e| internal("sensitive-marks", &e))?;
        marks.restore_carries(loaded.carries);
        for (n, mark) in loaded.pending {
            owed.recovered.push(n);
            for session in marks.restore(mark.origin, mark.sessions.into_keys().collect(), mark.values) {
                if !mark.settled.contains(&session) {
                    owed.owed.entry(session).or_default().push(n);
                }
            }
        }
        // The log reads' copy first, then the catalog: the copy never holds less than the catalog (`OwedRewrites`). The
        // catalog is set to exactly these sessions, so whatever an earlier start left withheld and owes nothing now goes.
        // This is the only place either set is added to, and it runs at boot, before any thread is served: the copy's
        // safety rests on no session being withheld again after its release in the same boot.
        self.owed.begin(owed.owed.keys().cloned());
        self.index.withhold(owed.owed.keys().cloned().collect()).await.map_err(|e| internal("sensitive-marks-withhold", &e))?;
        if let Some(progress) = progress {
            progress.extend(owed.owed.len());
        }
        Ok(owed)
    }

    /// One owed session's log rewritten for every value its marks hold, and its rows rebuilt from the rewritten log; again
    /// while a mark arrived meanwhile. The version of the marks it was rewritten for.
    #[allow(clippy::disallowed_methods, reason = "the session folder is looked up inside the durability lane job")]
    async fn rewrite_owed(
        &self,
        durability: DurabilityIo,
        stop: &mixdog_rt::CancellationToken,
        marks: &Arc<dyn super::seams::SensitiveMarks>,
        session: &str,
    ) -> Result<u64, CoreError> {
        // The job waits out a full lane: a mark owed is settled, not skipped for a busy one; a quit ends the wait.
        use mixdog_core_base::support::on_lane_wait as wait;
        let id = ThreadId::from(session);
        loop {
            let version = marks.version(&id);
            let (dir, data, deps, session) = (self.dir(session), self.data.clone(), self.writer.clone(), session.to_owned());
            let (rewriting, runtime, index) = (marks.clone(), self.runtime.clone(), self.index.clone());
            wait(durability, stop, move |lane| -> Result<(), String> {
                // The rebuilt rows stay withheld: the session is released apart, once settled ([`MarkRewrites::settle_one`]).
                let mut index_step = || {
                    let rewrite = mixdog_store::sqlite::Rewritten { data: data.clone(), session: session.clone(), dirty: DirtyMark::Set };
                    let block = || runtime.block_on(index.reproject(rewrite));
                    let result = if tokio::runtime::Handle::try_current().is_ok() { tokio::task::block_in_place(block) } else { block() };
                    result.map_err(|e| e.to_string())
                };
                let mut settle =
                    || mixdog_store::log_rewrite::settle(lane, &data, &session, &*deps.io, &deps.blobs, &mut index_step).map_err(|e| e.to_string());
                // A retry on this store may find the directory moved away or already redacted,
                // with the index and old log still owed. Finish that intent before inspecting the log.
                settle()?;
                match std::fs::metadata(&dir) {
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                    Err(e) => return Err(e.to_string()),
                }
                let opened = log::open_log(lane, &dir, &deps.blobs, &*deps.index).map_err(|e| e.to_string())?;
                if let log::LogStatus::Damaged(damage) = opened.status {
                    return Err(OpenAppendError::StoreDamaged(damage).to_string());
                }
                if let Some(lost) = opened.lost.as_ref() {
                    return Err(OpenAppendError::BodiesLost(lost.clone()).to_string());
                }
                // For a torn tail keep the writer's rollback (including sync), even if no committed frame changes.
                // A clean log needs no append handle, and neither case needs an open after the rewrite.
                if matches!(opened.status, log::LogStatus::Torn { .. }) {
                    let mut writer = LogWriter::open(lane, opened, deps.clone()).map_err(|e| e.to_string())?;
                    writer.retry_storage(lane).map_err(|e| e.to_string())?;
                } else {
                    mixdog_store::fsio::sweep_tmp(lane, &dir).map_err(|e| e.to_string())?;
                }
                let id = ThreadId::from(session.as_str());
                let mut replace = rewriting.rewriter(&id);
                if mixdog_store::log_rewrite::plan(lane, &data, &session, &*deps.io, &deps.blobs, &mut *replace).map_err(|e| e.to_string())? {
                    settle()?;
                }
                Ok(())
            })
            .await?
            .map_err(|error| internal("sensitive-marks", &error))?;
            if marks.version(&id) == version {
                return Ok(version);
            }
        }
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
        Box::new(StoreLog {
            writer: Some(writer),
            projector: self.projector.clone(),
            redaction,
            retention: self.retention.clone(),
            thread: id.as_str().to_owned(),
            context_lens: self.context_lens.clone(),
        })
    }

    /// Moves whenever any session's favorite or archive mark is written through this store's logs, the only writers of a
    /// header: what was derived from those marks is stale once it differs from the value it was derived at.
    pub fn retention(&self) -> u64 {
        self.retention.load(std::sync::atomic::Ordering::Acquire)
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
        mixdog_rt::LaneToken::submit(maintenance, &mixdog_rt::CancellationToken::new(), move |_lane| mixdog_store::fsio::create_dir_durable(&sessions))
            .map_err(|_| internal("sessions-dir", &"maintenance lane refused"))?
            .await
            .map_err(|_| internal("sessions-dir", &"maintenance job dropped"))?
            .map_err(|e| internal("sessions-dir", &e))?;
        let blobs = BlobStore::new(data);
        let writer = WriterDeps { io: Arc::new(mixdog_store::log::OsIo), blobs: blobs.clone(), ownership, index: Arc::new(index.clone()) };
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

    /// A stale position must not make backfill skip an acknowledged but unprojected write.
    pub(crate) async fn search_position(&self, session: &str) -> Result<Option<mixdog_store::schema::checkpoint::FramePos>, CoreError> {
        self.projector.indexed(session).await?;
        self.index.projected(session).await.map_err(|e| internal("search stamp", &e))
    }

    pub(super) fn search_shape(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Arc<LogShape>, CoreError> {
        let _gate = self.read_gate(id)?;
        self.shape(lane, id)
    }

    /// Returns once the index holds every write acked so far (the projection runs behind the ack).
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build")
    )]
    pub(crate) async fn projected(&self) {
        self.projector.drained().await;
    }

    fn not_found(id: &ThreadId) -> CoreError {
        CoreError::ThreadNotFound { thread_id: id.clone() }
    }

    fn open_error(id: &ThreadId, error: OpenError) -> CoreError {
        match error {
            OpenError::Missing(_) => Self::not_found(id),
            OpenError::Io(e) if e.source.kind() == std::io::ErrorKind::NotFound => Self::not_found(id),
            other => internal("open", &other),
        }
    }

    /// The bounded open of a thread's log; `threadNotFound` for an unknown or deleted thread
    /// (its header's delete mark). A fork still reads a deleted base's logs: `lineage` opens
    /// them directly.
    fn open(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<log::OpenedLog, CoreError> {
        let opened = log::open_log(lane, &self.dir(id.as_str()), &self.blobs, &self.index).map_err(|e| Self::open_error(id, e))?;
        if mixdog_store::summary::is_deleted(&opened.fold.header) {
            return Err(Self::not_found(id));
        }
        Ok(opened)
    }

    /// What the row reads take from `id`'s opened log. A count or a tail of an idle thread is asked again and again (an
    /// agent row's message count on every status pass, the desktop's final-answer read while it waits), and each was a
    /// bounded open: the newest file's tail read and every record in it parsed. It is opened again only when one of the
    /// logs it was folded from (the thread's own and each base's) was written since in a way that may change the shape,
    /// which `log_epoch` counts by the operations that write a log, not by what the files look like: a truncation grown
    /// back or a rewrite in place leaves the files' listing, lengths and write times as they were. An append of records
    /// that rewind nothing and delete nothing leaves the shape as it is (a running thread appends on every step, and each
    /// status pass asks its message count), so the kept one answers, at the logs' versions of now. A deleted thread's
    /// delete mark moves the shape's version and the open that follows refuses it.
    ///
    /// A shape is kept only when the shape versions of its logs, taken before the open, are the ones after it and no
    /// operation that may change the shape ran either time: what was read is then the shape of that version, whichever
    /// appends ran beside the read. The bases are known only once the log is read; a read that finds other logs than the
    /// ones whose versions it took is made again over those.
    fn shape(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Arc<LogShape>, CoreError> {
        let lock = || self.shapes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let versions = |logs: &[String]| logs.iter().map(|log| mixdog_store::log_epoch::settled(log)).collect::<Option<Vec<u64>>>();
        let shapes = |logs: &[String]| logs.iter().map(|log| mixdog_store::log_epoch::shape_settled(log)).collect::<Option<Vec<u64>>>();
        let held = lock().get(id.as_str()).cloned();
        if let Some(held) = &held {
            if held.is_current() {
                return Ok(held.clone());
            }
            // The versions first: an append that begins after them leaves this shape not current, whatever it holds.
            let now = versions(&held.logs);
            if held.stands() {
                let shape = Arc::new(LogShape {
                    logs: held.logs.clone(),
                    versions: now.unwrap_or_default(),
                    shapes: held.shapes.clone(),
                    lineage: held.lineage.clone(),
                    base_cut: held.base_cut,
                    history_rev: held.history_rev,
                });
                lock().insert(id.as_str().to_owned(), shape.clone());
                return Ok(shape);
            }
        }
        let mut logs = held.map_or_else(|| vec![id.as_str().to_owned()], |held| held.logs.clone());
        loop {
            let (before, shaped) = (versions(&logs), shapes(&logs));
            let read = self.open(lane, id).and_then(|opened| Ok((self.lineage(lane, &opened.fold)?, opened.fold.base_cut, opened.fold.history_rev)));
            let (lineage, base_cut, history_rev) = match read {
                Ok(read) => read,
                Err(error) => {
                    lock().remove(id.as_str());
                    return Err(error);
                }
            };
            let read_logs: Vec<String> =
                std::iter::once(id.as_str().to_owned()).chain(lineage.iter().skip(1).map(|level| level.session.as_str().to_owned())).collect();
            if read_logs != logs {
                logs = read_logs;
                continue;
            }
            let current = before.filter(|before| versions(&logs).as_ref() == Some(before));
            let kept = shaped.filter(|shaped| shapes(&logs).as_ref() == Some(shaped));
            let keep = kept.is_some();
            let shape = Arc::new(LogShape {
                logs,
                versions: current.unwrap_or_default(),
                shapes: kept.unwrap_or_default(),
                lineage: Arc::new(lineage),
                base_cut,
                history_rev,
            });
            if keep {
                lock().insert(id.as_str().to_owned(), shape.clone());
            } else {
                lock().remove(id.as_str());
            }
            return Ok(shape);
        }
    }

    /// The shape a row read of `id` takes now, under the read gate as a read holds it.
    #[cfg(test)]
    pub(super) fn shape_now(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Arc<LogShape> {
        let _gate = self.read_gate(id).expect("the thread owes no rewrite");
        self.shape(lane, id).expect("the thread's shape")
    }

    /// The length of `id`'s model context as a reader is shown it from memory, and as the index counts it now.
    #[cfg(test)]
    pub(super) fn context_len_kept_and_counted(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> (Option<usize>, usize) {
        let kept = ThreadStore::context_len_kept(self, id);
        let _gate = self.read_gate(id).expect("the thread owes no rewrite");
        let shape = self.shape(lane, id).expect("the thread's shape");
        (kept, self.index.context_len_on_lane(lane, &shape.lineage, shape.base_cut).expect("the index counts"))
    }

    /// Whether a row read of `id` is refused now as one of a thread that is not there.
    #[cfg(test)]
    pub(super) fn shape_refused(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> bool {
        let _gate = self.read_gate(id).expect("the thread owes no rewrite");
        matches!(self.shape(lane, id), Err(CoreError::ThreadNotFound { .. }))
    }

    /// What `shape` answers for `id` against an open made now: its history revision and inherited-history cut, each twice.
    #[cfg(test)]
    pub(super) fn shape_and_open(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> ((u64, Option<u64>), (u64, Option<u64>)) {
        let _gate = self.read_gate(id).expect("the thread owes no rewrite");
        let shape = self.shape(lane, id).expect("the thread's shape");
        let opened = self.open(lane, id).expect("the thread's log");
        ((shape.history_rev, shape.base_cut), (opened.fold.history_rev, opened.fold.base_cut))
    }

    fn read_error(id: &ThreadId, error: ReadError) -> CoreError {
        match error {
            ReadError::Damaged(d) => CoreError::StoreDamaged { thread_id: id.clone(), file_no: u64::from(d.file_no), offset: d.offset },
            ReadError::Io(e) => internal("read", &e),
        }
    }

    /// An out-of-line slot read back from the blob store.
    fn resolve<T: DeserializeOwned + Clone, L: IoLane>(&self, lane: &InLane<L>, slot: &Slot<T>) -> Result<Slot<T>, CoreError> {
        match slot {
            Slot::Inline(_) => Ok(slot.clone()),
            Slot::Blob(blob) => {
                let bytes = self.blobs.read(lane, &blob.descriptor().digest).map_err(|e| internal("blob", &e))?;
                serde_json::from_slice(&bytes).map(Slot::Inline).map_err(|e| internal("blob", &e))
            }
        }
    }

    /// `[session, base, base's base, …]` with each base's fork point (FORMAT.md §5.3).
    fn lineage(&self, lane: &InLane<InteractiveIo>, fold: &Fold) -> Result<Vec<LineageLevel>, CoreError> {
        let mut levels = vec![LineageLevel { session: fold.session.clone(), end: None }];
        let mut base = fold.base.clone();
        while let Some(level) = base {
            if levels.len() >= MAX_LINEAGE {
                return Err(internal("lineage", &"fork chain too deep"));
            }
            // A fork reads its base's log: a base that owes its sensitive rewrite is not read through the fork either.
            self.owes_nothing(level.session.as_str())?;
            let dir = self.dir(level.session.as_str());
            let head = log::read_head(lane, &dir).map_err(|e| internal("lineage", &e))?;
            let tail = log::read_tail(lane, head, &self.blobs, &self.index).map_err(|e| internal("lineage", &e))?;
            base = tail.anchor_fold().base.clone();
            levels.push(LineageLevel { session: level.session.as_str().to_owned(), end: Some(level.end_ordinal_exclusive) });
        }
        Ok(levels)
    }

    /// The draft of the run `rid` that `started` begins: the `draft` records a log written before held, folded over every
    /// frame from there to the log's end (a checkpoint between them does not carry it), then the run's draft file.
    fn run_draft(&self, lane: &InLane<InteractiveIo>, dir: &Path, rid: &str, started: FramePos) -> Result<RunDraft, CoreError> {
        let mut draft = RunDraft::default();
        let mut landed = std::collections::HashSet::new();
        let mut from = started;
        loop {
            let read = log::read_forward(lane, dir, from, 1 << 20).map_err(|e| internal("drafts", &e))?;
            for (record, _, _) in &read.frames {
                match record {
                    Record::Draft(record) if record.rid.as_str() == rid => {
                        if let Slot::Inline(body) = self.resolve(lane, &record.body)? {
                            draft.apply(&body);
                        }
                    }
                    Record::Item(item)
                        if item.turn.as_ref().is_some_and(|turn| turn.as_str() == rid)
                            && item.role.as_ref().is_some_and(|role| role.as_str() == "assistant") =>
                    {
                        landed.insert(item.iid.as_str().to_owned());
                        draft.message_committed();
                    }
                    _ => {}
                }
            }
            match read.next {
                log::ForwardEnd::More(next) => from = next,
                log::ForwardEnd::Done { .. } => break,
                log::ForwardEnd::Damaged(damage) => return Err(internal("drafts", &format!("{damage:?}"))),
            }
        }
        let bodies = mixdog_store::draft_file::read(lane, dir, rid).map_err(|e| internal("drafts", &e))?;
        draft.apply_file(&bodies, |iid| landed.contains(iid));
        Ok(draft)
    }

    fn frame_at(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, dir: &Path, pos: FramePos) -> Result<Record, CoreError> {
        log::read_frame_at(lane, dir, pos).map_err(|e| Self::read_error(id, e))
    }

    /// The newest `want` rows of the lineage's history from `cursor` (the newest row when none), newest first, and whether
    /// they are all that is left; `None` when a rewind moved the history under the cursor.
    fn read_rows(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        cursor: Option<mixdog_store::sqlite::PageCursor>,
        want: usize,
    ) -> Result<Option<(Vec<ItemRecord>, bool)>, CoreError> {
        Ok(self.read_rows_marked(lane, id, lineage, cut, cursor, want, None)?.map(|(rows, _, complete)| (rows, complete)))
    }

    /// [`read_rows`](Self::read_rows) with the index rows the records were read from (the same order).
    #[allow(clippy::too_many_arguments)]
    fn read_rows_marked(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        mut cursor: Option<mixdog_store::sqlite::PageCursor>,
        want: usize,
        cancel: Option<&mixdog_rt::CancellationToken>,
    ) -> Result<Option<StoredHistoryPage>, CoreError> {
        let mut rows = Vec::new();
        let mut marks = Vec::new();
        loop {
            if let Some(cancel) = cancel {
                check_turn_read_cancel(cancel)?;
            }
            // One row more than wanted says whether more are left: never an index row past what the page needs.
            let room = want - rows.len();
            let (page, next) = match self.index.history_page_on_lane(lane, lineage, cut, cursor, WINDOW_ROWS.min(room.saturating_add(1))) {
                Ok(page) => page,
                Err(DbError::CursorStale) => return Ok(None),
                Err(e) => return Err(internal("history", &e)),
            };
            // Only the rows still wanted are read from the log.
            for row in page.iter().take(room) {
                if let Some(cancel) = cancel {
                    check_turn_read_cancel(cancel)?;
                }
                rows.push(self.history_item(lane, id, row)?);
            }
            let more = page.len() > room;
            marks.extend(page.into_iter().take(room));
            if more {
                return Ok(Some((rows, marks, false)));
            }
            // The index keeps a continuation cursor at its exact page limit, so with the wanted rows all read the
            // next page says whether any row is left (it is read, empty, and ends the history).
            match next {
                Some(next) => cursor = Some(next),
                None => return Ok(Some((rows, marks, true))),
            }
        }
    }

    fn history_with_decor(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        want: usize,
        cancel: Option<&mixdog_rt::CancellationToken>,
    ) -> Result<(u64, Vec<ItemRecord>, Vec<super::seams::RowDecor>, bool), CoreError> {
        let barrier = self.projector.caught_up();
        if let Some(cancel) = cancel {
            self.wait(lane, mixdog_rt::Scope::new().cancel(cancel).run(barrier)).done().ok_or_else(turn_read_cancelled)??;
        } else {
            self.wait(lane, barrier)?;
        }
        let _gate = self.read_gate(id)?;
        loop {
            if let Some(cancel) = cancel {
                check_turn_read_cancel(cancel)?;
            }
            let shape = self.shape(lane, id)?;
            let Some((mut rows, marks, complete)) = self.read_rows_marked(lane, id, &shape.lineage, shape.base_cut, None, want, cancel)? else {
                continue;
            };
            if let Some(cancel) = cancel {
                check_turn_read_cancel(cancel)?;
            }
            let decor = self.page_decor(lane, &shape.lineage, shape.base_cut, &marks, complete, true)?;
            rows.reverse();
            return Ok((shape.history_rev, rows, decor, complete));
        }
    }

    /// The [`RowDecor`] of each of `rows` (newest first, as paged; the result is oldest first): what
    /// [`read_window`](ThreadStore::read_window) marks of the same rows. `complete` says no row is older than these.
    /// A divider goes after the newest row older than it; one newer than every row is given to the last row only
    /// when these rows end the history (`trailing`), else it belongs to a newer page.
    fn page_decor(
        &self,
        lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        rows: &[HistoryRow],
        complete: bool,
        trailing: bool,
    ) -> Result<Vec<super::seams::RowDecor>, CoreError> {
        let archived = archived_ordinals(rows);
        let mut decor: Vec<super::seams::RowDecor> =
            rows.iter().rev().map(|row| super::seams::RowDecor { archived: archived.contains(&row.ordinal), dividers_after: Vec::new() }).collect();
        for divider in self.window_dividers(lane, lineage, cut, rows, !complete)? {
            // `before` counts the rows older than the divider: it follows the last of them.
            let Some(host) = divider.before.checked_sub(1) else { continue };
            if divider.before == decor.len() && !trailing {
                continue;
            }
            if let Some(row) = decor.get_mut(host) {
                row.dividers_after.push(divider);
            }
        }
        Ok(decor)
    }

    /// The item record of one history row: its frame, its latest amend's body, and both
    /// out-of-line slots read back.
    fn history_item(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, row: &HistoryRow) -> Result<ItemRecord, CoreError> {
        #[cfg(any(test, feature = "test-support"))]
        mixdog_store::read_count::add(id.as_str(), 1);
        let dir = self.dir(&row.session);
        let Record::Item(mut item) = log::read_frame(lane, &dir, row.pos, row.frame_len).map_err(|e| Self::read_error(id, e))? else {
            return Err(unexpected("item"));
        };
        if let Some((pos, len)) = row.amend {
            let Record::Amend(amend) = log::read_frame(lane, &dir, pos, len).map_err(|e| Self::read_error(id, e))? else {
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
                let before = shown.iter().filter(|(shown, ordinal)| *shown > level || (*shown == level && *ordinal < divider.boundary)).count();
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
impl StoreThreads {
    /// The first page of the read, over the lineage as of now; the caller holds the read gate at `generation`.
    fn context_start(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, generation: u64, skip: usize) -> Result<ContextState, CoreError> {
        let shape = self.shape(lane, id)?;
        let lineage = shape.lineage.as_ref().clone();
        let cut = shape.base_cut;
        let page = if skip == 0 {
            self.index.context_page_on_lane(lane, &self.sessions, &lineage, cut, None, CONTEXT_PAGE_ROWS)
        } else {
            self.index.context_page_from_on_lane(lane, &self.sessions, &lineage, cut, skip)
        }
        .map_err(|e| internal("context", &e))?;
        Ok(ContextState { lineage, cut, first: true, at: ContextAt::Page(page), generation, skip })
    }

    /// The cpu end of a page: its messages, then the next page or the whole context.
    fn context_finish(lane: &InLane<CpuInteractive>, mut state: ContextState, decoded: DecodedContext, blobs: ContextBlobs) -> Result<ContextStep, CoreError> {
        let next = decoded.next;
        let rows = finish_context(lane, decoded, blobs).map_err(|e| internal("context", &e))?.into_iter().map(|m| (ItemId::from(m.iid), m.body)).collect();
        let first = state.first;
        let next = next.map(|cursor| {
            state.first = false;
            state.at = ContextAt::Next(cursor);
            ContextRead(Box::new(state))
        });
        Ok(ContextStep::Page { first, rows, next })
    }
}
impl ThreadStore for StoreThreads {
    #[allow(clippy::disallowed_methods, reason = "runs inside an interactive-io lane job (lane proof argument)")]
    fn read_head(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<HeadRead, CoreError> {
        let _gate = self.read_gate(id)?;
        if !self.dir(id.as_str()).is_dir() {
            return Err(Self::not_found(id));
        }
        let opened = self.open(lane, id)?;
        // A session kept only to host a worker row has no record: no thread opens over it (Node reads its header as null).
        if opened.fold.header.get(mixdog_store::archived_agent::WORKER_ROW_ONLY_KEY).and_then(Value::as_bool) == Some(true) {
            return Err(Self::not_found(id));
        }
        Ok(HeadRead(Box::new(opened)))
    }

    #[allow(clippy::disallowed_methods, reason = "runs inside an interactive-io lane job (lane proof argument)")]
    fn read_header(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Header, CoreError> {
        let _gate = self.read_gate(id)?;
        if !self.dir(id.as_str()).is_dir() {
            return Err(Self::not_found(id));
        }
        Ok(self.open(lane, id)?.fold.header)
    }

    /// Kept by the version of the session's log (`log_epoch`), as [`StoreThreads::shape`] is: the header is folded
    /// from the session's own log alone, so the picked members hold until an operation on that log begins.
    fn read_header_fields(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, fields: &'static [&'static str]) -> Result<Option<Header>, CoreError> {
        let lock = || self.picked.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let key = (id.as_str().to_owned(), fields.as_ptr() as usize, fields.len());
        let version = mixdog_store::log_epoch::settled(id.as_str());
        if let Some(version) = version
            && let Some((_, held)) = lock().get(&key).filter(|(at, _)| *at == version)
        {
            return Ok(held.clone());
        }
        let header = match self.read_header(lane, id) {
            Ok(header) => header,
            Err(error) => {
                lock().remove(&key);
                return Err(error);
            }
        };
        let picked = super::seams::header_fields(&header, fields);
        match version.filter(|version| mixdog_store::log_epoch::settled(id.as_str()) == Some(*version)) {
            Some(version) => lock().insert(key, (version, picked.clone())),
            None => lock().remove(&key),
        };
        Ok(picked)
    }

    fn listed_rows(&self, lane: &InLane<InteractiveIo>, ids: &[ThreadId]) -> Result<Vec<Option<Option<Header>>>, CoreError> {
        let ids: Vec<String> = ids.iter().map(|id| id.as_str().to_owned()).collect();
        let rows = self.index.listed_many(lane, &ids).map_err(|e| internal("listed", &e))?;
        // A row that does not parse is not an answer: the record is read instead.
        Ok(rows
            .into_iter()
            .map(|row| match row? {
                None => Some(None),
                Some(json) => serde_json::from_str::<Header>(&json).ok().map(Some),
            })
            .collect())
    }

    fn read_log_id(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<String, CoreError> {
        let _gate = self.read_gate(id)?;
        Ok(self.open(lane, id)?.fold.log_id.clone())
    }

    fn read_window(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, head: &HeadRead) -> Result<WindowRead, CoreError> {
        // The window comes from the index: it must hold every barrier acked so far (a thread
        // unloaded and reopened in this process).
        self.wait(lane, self.projector.caught_up())?;
        // The head was read in an earlier job; only the thread's own loaded actor rewrites its log, and a head is read
        // to load the thread, so no rewrite of this log comes between the two.
        let _gate = self.read_gate(id)?;
        let opened = head.0.downcast_ref::<log::OpenedLog>().expect("StoreThreads head");
        let fold = &opened.fold;
        let lineage = self.lineage(lane, fold)?;
        let (rows, cursor) = self.index.history_page_on_lane(lane, &lineage, fold.base_cut, None, WINDOW_ROWS).map_err(|e| internal("window", &e))?;
        let mut window = Vec::with_capacity(rows.len());
        for row in rows.iter().rev() {
            window.push((row.ordinal, self.history_item(lane, id, row)?));
        }
        let archived = archived_ordinals(&rows);
        let dividers = self.window_dividers(lane, &lineage, fold.base_cut, &rows, cursor.is_some())?;
        let prompts = self.index.prompts_on_lane(lane, &lineage, fold.base_cut).map_err(|e| internal("prompts", &e))?;
        let dir = &opened.dir;
        let mut runs = Vec::new();
        let mut drafts = Vec::new();
        for run in &fold.runs {
            let Record::Run(mut record) = self.frame_at(lane, id, dir, run.started)? else {
                return Err(unexpected("run"));
            };
            if let Some(detail) = &record.detail {
                record.detail = Some(self.resolve(lane, detail)?);
            }
            let mut draft = self.run_draft(lane, dir, &run.rid, run.started)?;
            // The run's input row is the row just before its start; past the window (a turn of many rows) it is read here.
            if let Some(cursor) = cursor {
                let before = mixdog_store::sqlite::PageCursor { level: 0, before: run.started.ordinal, ..cursor };
                let (input, _) = self.index.history_page_on_lane(lane, &lineage, fold.base_cut, Some(before), 1).map_err(|e| internal("window", &e))?;
                draft.input = input.into_iter().find(|row| row.turn.as_deref() == Some(run.rid.as_str())).map(|row| row.iid);
            }
            drafts.push((run.rid.clone(), draft));
            runs.push((run.started.ordinal, record));
        }
        let mut approvals = Vec::new();
        for approval in &fold.approvals {
            let Record::Approval(mut record) = self.frame_at(lane, id, dir, approval.requested)? else {
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
        Ok(WindowRead(Box::new(Window { window, archived, dividers, has_older: cursor.is_some(), prompts, runs, drafts, approvals, queue })))
    }

    fn decode(&self, _lane: &InLane<CpuInteractive>, _id: &ThreadId, head: HeadRead, window: WindowRead) -> Result<OpenedLog, CoreError> {
        let opened = *head.0.downcast::<log::OpenedLog>().expect("StoreThreads head");
        let read = *window.0.downcast::<Window>().expect("StoreThreads window");
        let fold = &opened.fold;
        // `thread/clear` rewinds to the lineage's first row: a fork may cut into its base.
        let lineage_start = if fold.base.is_some() { 0 } else { fold.start_ordinal + 1 };
        Ok(OpenedLog {
            header: fold.header.clone(),
            control: fold.control,
            history_rev: fold.history_rev,
            lineage_start,
            runs: read.runs,
            approvals: read.approvals,
            queue: read.queue,
            window: read.window,
            archived: read.archived,
            dividers: read.dividers,
            has_older: read.has_older,
            prompts: read.prompts,
            log_id: fold.log_id.clone(),
            next_ordinal: fold.next_ordinal,
            tail: Vec::new(),
            drafts: read.drafts,
            append: AppendPosition(Box::new(opened)),
        })
    }

    /// The whole lineage's prompt rows, as the index keeps them (newest 50, deduped), once the
    /// index holds the history mutation that asked for them.
    fn user_rows(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Vec<ItemRecord>, CoreError> {
        self.wait(lane, self.projector.caught_up())?;
        let _gate = self.read_gate(id)?;
        let opened = self.open(lane, id)?;
        let lineage = self.lineage(lane, &opened.fold)?;
        let prompts = self.index.prompts_on_lane(lane, &lineage, opened.fold.base_cut).map_err(|e| internal("prompts", &e))?;
        // Oldest first, as the seam returns rows; only `prompt` is read by the caller.
        Ok(prompts.into_iter().rev().map(prompt_row).collect())
    }

    /// Every page of the lineage's history, as acked so far; a page after a rewind restarts
    /// the read over the new history.
    fn history_rows(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<(u64, Vec<ItemRecord>), CoreError> {
        let (rev, rows, _) = self.history_tail(lane, id, usize::MAX)?;
        Ok((rev, rows))
    }

    fn history_tail(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, want: usize) -> Result<(u64, Vec<ItemRecord>, bool), CoreError> {
        self.wait(lane, self.projector.caught_up())?;
        let _gate = self.read_gate(id)?;
        loop {
            let shape = self.shape(lane, id)?;
            let Some((mut rows, complete)) = self.read_rows(lane, id, &shape.lineage, shape.base_cut, None, want)? else {
                continue;
            };
            // Pages run newest first; the seam returns rows oldest first.
            rows.reverse();
            return Ok((shape.history_rev, rows, complete));
        }
    }

    fn turn_history_chunk(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        after: Option<super::seams::TurnHistoryCursor>,
        cancel: &mixdog_rt::CancellationToken,
    ) -> Result<Option<super::seams::TurnHistoryChunk>, CoreError> {
        use super::seams::{TurnHistoryChunk, TurnHistoryCursor};
        use mixdog_store::sqlite::PageCursor;

        const RECORDS_PER_CHUNK: usize = 16;
        check_turn_read_cancel(cancel)?;
        let _gate = self.read_gate(id)?;
        check_turn_read_cancel(cancel)?;
        let (shape, cursor) = match after {
            Some(after) => *after.0.downcast::<(Arc<LogShape>, PageCursor)>().expect("turn history cursor"),
            None => {
                let shape = self.shape(lane, id)?;
                if !shape.is_current() {
                    return Ok(None);
                }
                // An append can be durable but not yet projected even when history_rev is unchanged.
                // Prove the starting index view against the logs, not the global projector queue.
                for session in &shape.logs {
                    check_turn_read_cancel(cancel)?;
                    let opened = log::open_log(lane, &self.dir(session), &self.blobs, &self.index).map_err(|error| Self::open_error(id, error))?;
                    let end = FramePos { ordinal: opened.fold.next_ordinal, file_no: opened.newest_file_no, offset: opened.committed_end };
                    if !self.index.history_projected_through_on_lane(lane, session, &opened.fold.log_id, end).map_err(|error| internal("history", &error))? {
                        return Ok(None);
                    }
                }
                let cursor = PageCursor { history_rev: shape.history_rev, level: 0, before: u64::MAX };
                (shape, cursor)
            }
        };
        // Once caught up, only a change to one of these logs can move the scan's index view.
        // The read gate excludes rewrites during each chunk; log epochs cover changes between chunks.
        if !shape.is_current() {
            return Ok(None);
        }
        let (rows, next) = match self.index.history_page_on_lane(lane, &shape.lineage, shape.base_cut, Some(cursor), RECORDS_PER_CHUNK) {
            Ok(page) => page,
            Err(DbError::CursorStale) => return Ok(None),
            Err(error) => return Err(internal("history", &error)),
        };
        let records = rows
            .iter()
            .map(|row| {
                check_turn_read_cancel(cancel)?;
                self.history_item(lane, id, row)
            })
            .collect::<Result<Vec<_>, _>>();
        check_turn_read_cancel(cancel)?;
        if !shape.is_current() {
            return Ok(None);
        }
        let next = next.map(|cursor| TurnHistoryCursor(Box::new((shape, cursor))));
        Ok(Some(TurnHistoryChunk { records: records?, next }))
    }

    fn turn_history_full(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        cancel: &mixdog_rt::CancellationToken,
    ) -> Result<(Vec<ItemRecord>, Vec<super::seams::RowDecor>), CoreError> {
        let (_, records, decor, _) = self.history_with_decor(lane, id, usize::MAX, Some(cancel))?;
        Ok((records, decor))
    }

    fn window_archived(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Vec<u64>, CoreError> {
        self.wait(lane, self.projector.caught_up())?;
        let _gate = self.read_gate(id)?;
        let opened = self.open(lane, id)?;
        let lineage = self.lineage(lane, &opened.fold)?;
        // The rows `read_window` reads, and its verdict of them.
        let (rows, _) = self.index.history_page_on_lane(lane, &lineage, opened.fold.base_cut, None, WINDOW_ROWS).map_err(|e| internal("window", &e))?;
        Ok(archived_ordinals(&rows))
    }

    fn history_tail_decor(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        want: usize,
    ) -> Result<(u64, Vec<ItemRecord>, Vec<super::seams::RowDecor>, bool), CoreError> {
        self.history_with_decor(lane, id, want, None)
    }

    fn history_before(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, anchor: &str, rows: usize) -> Result<Option<HistoryBefore>, CoreError> {
        self.wait(lane, self.projector.caught_up())?;
        let _gate = self.read_gate(id)?;
        loop {
            let opened = self.open(lane, id)?;
            let lineage = self.lineage(lane, &opened.fold)?;
            let cut = opened.fold.base_cut;
            let (ids, alias) = match super::reads::history_cursor_iid(anchor) {
                Some(iid) => (vec![iid.to_owned()], ""),
                None => (anchor_iids(anchor), anchor),
            };
            let named = self.index.history_anchor_on_lane(lane, &lineage, cut, &ids, alias).map_err(|e| internal("history", &e))?;
            let Some(named) = named else {
                return Ok(None);
            };
            // The named record first, then the `rows` older.
            let Some((mut records, marks, complete)) = self.read_rows_marked(lane, id, &lineage, cut, Some(named.cursor), rows.saturating_add(1), None)? else {
                continue;
            };
            // The newest record is the cursor's own: what follows it belongs to the page that shows it.
            let decor = self.page_decor(lane, &lineage, cut, &marks, complete, false)?;
            records.reverse();
            return Ok(Some(HistoryBefore { rev: opened.fold.history_rev, records, complete, named: named.named, decor }));
        }
    }

    fn thread_op(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, op: &str) -> Result<Option<StoredOp>, CoreError> {
        self.wait(lane, self.projector.caught_up())?;
        let _gate = self.read_gate(id)?;
        let Some(row) = self.index.thread_op_on_lane(lane, id.as_str(), op).map_err(|e| internal("thread-op", &e))? else {
            return Ok(None);
        };
        let record = log::read_frame(lane, &self.dir(id.as_str()), row.pos, row.frame_len).map_err(|e| Self::read_error(id, e))?;
        let op_ref = super::thread_ops::op_ref_of(&record);
        let result = op_ref.and_then(|o| o.result.as_ref()).map(|r| r.get().clone());
        let audience = op_ref.and_then(|o| o.audience.as_ref()).map(|a| a.as_str().to_owned());
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
        Ok(Some(StoredOp { method: row.method, digest: row.payload_digest, audience, state: row.state, seq: row.pos.ordinal, result, detail }))
    }

    fn submission(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, submission: &str) -> Result<Option<Value>, CoreError> {
        self.wait(lane, self.projector.caught_up())?;
        let _gate = self.read_gate(id)?;
        self.index.submission_on_lane(lane, id.as_str(), submission).map_err(|e| internal("submission", &e))
    }

    fn fenced_ops(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Vec<String>, CoreError> {
        self.wait(lane, self.projector.caught_up())?;
        self.index.fenced_ops_on_lane(lane, id.as_str()).map_err(|e| internal("fenced-ops", &e))
    }

    /// Pages newest first until the row is found: a switch anchors near the history's end.
    fn history_row(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, iid: &str) -> Result<Option<(u64, ItemRecord)>, CoreError> {
        self.wait(lane, self.projector.caught_up())?;
        let _gate = self.read_gate(id)?;
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

    fn compaction_entry(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, iid: &str) -> Result<Option<mixdog_store::sqlite::CompactionEntry>, CoreError> {
        self.wait(lane, self.projector.caught_up())?;
        let _gate = self.read_gate(id)?;
        let opened = self.open(lane, id)?;
        let lineage = self.lineage(lane, &opened.fold)?;
        self.index.compaction_entry_on_lane(lane, &lineage, opened.fold.base_cut, iid).map_err(|e| internal("history", &e))
    }

    fn indexed(&self, id: &ThreadId) -> futures::future::BoxFuture<'static, Result<(), CoreError>> {
        let (projector, session) = (self.projector.clone(), id.as_str().to_owned());
        Box::pin(async move { projector.indexed(&session).await })
    }

    fn session_meta(&self, id: &ThreadId) -> futures::future::BoxFuture<'static, Result<Option<super::seams::SessionMeta>, CoreError>> {
        let (index, id) = (self.index.clone(), id.as_str().to_owned());
        Box::pin(async move {
            let Some(summary) = index.summary(&id).await.map_err(|e| internal("meta", &e))? else {
                return Ok(None);
            };
            let title = index.title(&id).await.map_err(|e| internal("meta", &e))?;
            Ok(Some(super::seams::SessionMeta::of(title, &summary)))
        })
    }

    fn archived_agent_parents(&self, child: &ThreadId) -> futures::future::BoxFuture<'static, Result<Vec<ThreadId>, CoreError>> {
        let (index, child) = (self.index.clone(), child.as_str().to_owned());
        Box::pin(async move {
            let parents = index.archived_agent_parents(&child).await.map_err(|e| internal("archived agent", &e))?;
            Ok(parents.into_iter().map(ThreadId::from).collect())
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
            // A session still owing its rewrite is left for a later purge by the index itself.
            projector.caught_up().await?;
            index.purge_deleted(lane, data).await.map_err(|e| internal("purge", &e))
        })
    }

    /// Pages run while the cursor holds; a page after a rewind or compaction restarts the
    /// read over the new lineage.
    fn context_io(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, read: Option<ContextRead>) -> Result<ContextRead, CoreError> {
        let Some(read) = read else {
            // The read must see every row acked so far.
            self.wait(lane, self.projector.caught_up())?;
            let gate = self.read_gate(id)?;
            return Ok(ContextRead(Box::new(self.context_start(lane, id, *gate, 0)?)));
        };
        let gate = self.read_gate(id)?;
        let mut state = *read.0.downcast::<ContextState>().expect("StoreThreads context");
        // A log rewritten since the read's earlier jobs: their positions and blobs are of the old log, so it starts again.
        if state.generation != *gate {
            return Ok(ContextRead(Box::new(self.context_start(lane, id, *gate, state.skip)?)));
        }
        state.at = match state.at {
            ContextAt::Next(cursor) => {
                match self.index.context_page_on_lane(lane, &self.sessions, &state.lineage, state.cut, Some(cursor), CONTEXT_PAGE_ROWS) {
                    Ok(page) => ContextAt::Page(page),
                    Err(ContextError::Db(DbError::CursorStale)) => {
                        return Ok(ContextRead(Box::new(self.context_start(lane, id, *gate, state.skip)?)));
                    }
                    Err(e) => return Err(internal("context", &e)),
                }
            }
            ContextAt::Decoded(decoded) => {
                let blobs = read_context_blobs(lane, &self.blobs, &decoded).map_err(|e| internal("context", &e))?;
                ContextAt::Finish(decoded, blobs)
            }
            ContextAt::Page(_) | ContextAt::Finish(..) | ContextAt::Pending => {
                return Err(internal("context", &"io step on a cpu state"));
            }
        };
        Ok(ContextRead(Box::new(state)))
    }

    fn context_cpu(&self, lane: &InLane<CpuInteractive>, read: ContextRead) -> Result<ContextStep, CoreError> {
        let state = *read.0.downcast::<ContextState>().expect("StoreThreads context");
        let ContextState { lineage, cut, first, at, generation, skip } = state;
        let rest = |at| ContextState { lineage, cut, first, at, generation, skip };
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
            ContextAt::Finish(decoded, blobs) => Self::context_finish(lane, rest(ContextAt::Pending), decoded, blobs),
            ContextAt::Next(_) | ContextAt::Decoded(_) | ContextAt::Pending => Err(internal("context", &"cpu step on an io state")),
        }
    }

    fn context_len_kept(&self, id: &ThreadId) -> Option<usize> {
        // A thread one of whose batches the index did not take is counted in the index by every reader
        // ([`context_len`](Self::context_len)): it has one length, whenever the loss fell. The number is taken before the
        // loss is asked, so one taken with no loss recorded was the thread's length then.
        let kept = self.context_lens.kept(id.as_str())?;
        (!self.projector.rows_lost(id.as_str())).then_some(kept)
    }

    fn context_len(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<usize, CoreError> {
        let counting = self.context_lens.counting(id.as_str());
        // The read must see every row acked so far, as a context read does.
        self.wait(lane, self.projector.caught_up())?;
        // The length is a position in the index's rows to its callers. What is kept is the log's count, which is the
        // index's only while the index took every batch of the thread: otherwise the index is asked, and nothing kept.
        let whole = !self.projector.rows_lost(id.as_str());
        if whole && let Some(len) = counting.kept() {
            return Ok(len);
        }
        let _gate = self.read_gate(id)?;
        let shape = self.shape(lane, id)?;
        let len = self.index.context_len_on_lane(lane, &shape.lineage, shape.base_cut).map_err(|e| internal("context", &e))?;
        if whole {
            self.context_lens.keep(id.as_str(), counting, &shape, len);
        }
        Ok(len)
    }

    fn context_from_io(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, skip: usize) -> Result<ContextRead, CoreError> {
        self.wait(lane, self.projector.caught_up())?;
        let gate = self.read_gate(id)?;
        Ok(ContextRead(Box::new(self.context_start(lane, id, *gate, skip)?)))
    }

    /// RL §9.2 rule 1: the session is marked dirty before the activation's first append.
    fn open_log(&self, lane: &InLane<DurabilityIo>, id: &ThreadId, at: AppendPosition) -> Result<Box<dyn SessionLog>, BarrierError> {
        // Its rewrite runs on the log without a writer: none is opened before it is done (a head was read before, so this is
        // only ever a thread whose head no read refused).
        if self.owed.holds(id.as_str()) {
            return Err(BarrierError::failed("sensitiveRewriteOwed"));
        }
        let opened = *at.0.downcast::<log::OpenedLog>().expect("StoreThreads position");
        self.wait(lane, self.index.mark_dirty(id.as_str())).map_err(|e| BarrierError::failed(&format!("index:{e}")))?;
        let writer = LogWriter::open(lane, opened, self.writer.clone()).map_err(|e| match e {
            // A fold that lost state with its blobs (mixdog-store FORMAT.md §4.5): read-only as a damaged log is.
            OpenAppendError::StoreDamaged(_) | OpenAppendError::BodiesLost(_) => BarrierError::failed("storeDamaged"),
            OpenAppendError::Io(e) => BarrierError::Failed { io_kind: e.op.to_string().into(), cause: e.source.to_string().into() },
        })?;
        Ok(self.store_log(id, writer))
    }

    /// RL §9.2 rule 4: the catalog row (dirty) is committed before `log.000000` is published.
    fn create_log(&self, lane: &InLane<DurabilityIo>, id: &ThreadId, session: &CommitRecord) -> Result<(Box<dyn SessionLog>, u64), BarrierError> {
        let failed = BarrierError::failed;
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
        let fold = Fold::from_session(record, header, FramePos { ordinal: start, file_no: 0, offset: 0 });
        self.wait(lane, self.index.upsert(CatalogHead::of(&fold), DirtyMark::Set)).map_err(|e| BarrierError::failed(&format!("index:{e}")))?;
        let entered = self.context_lens.batch(id.as_str());
        let (writer, ack) = LogWriter::create(lane, &self.dir(id.as_str()), session.encoded.0.clone(), self.writer.clone()).map_err(barrier)?;
        let ordinal = ack.positions[0].ordinal;
        let growth = super::context_lens::Growth::of(&ack.projection);
        entered.stored(growth, || self.projector.send(ack.projection));
        Ok((self.store_log(id, writer), ordinal))
    }

    fn draft_write(&self, lane: &InLane<DurabilityIo>, id: &ThreadId, write: &super::turn_draft::DraftWrite) -> Result<(), CoreError> {
        use super::turn_draft::DraftWrite;
        use mixdog_store::draft_file;
        let dir = self.dir(id.as_str());
        let done = match write {
            DraftWrite::Append { rid, body } => draft_file::append(lane, &dir, rid, body),
            DraftWrite::Replace { rid, body } => draft_file::replace(lane, &dir, rid, body),
            DraftWrite::Remove { rid } => draft_file::remove(lane, &dir, rid),
            DraftWrite::Sweep { open } => draft_file::list(lane, &dir)
                .and_then(|rids| rids.iter().filter(|rid| !open.contains(rid)).try_for_each(|rid| draft_file::remove(lane, &dir, rid))),
        };
        done.map_err(|e| internal("draft", &e))
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
    fn projected(
        &self,
        session: &str,
        record: &mixdog_store::schema::record::Record,
    ) -> (Option<mixdog_store::schema::record::Record>, Vec<(String, Option<Value>)>) {
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
            Record::Draft(draft) => prompt_changed = self.text_redacted(session, Some(&mut draft.body)),
            // A Stop's hand-back text is the prompt's.
            Record::WorkStop(stop) => prompt_changed = self.text_redacted(session, stop.body.as_mut()),
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

    fn restore_carries(&self, carries: Vec<(String, String)>) {
        self.store.restore_carries(carries);
    }

    fn restore(&self, origin: String, sessions: Vec<String>, values: Vec<String>) -> std::collections::BTreeSet<String> {
        self.store.restore(origin, sessions, values)
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

    fn redact_settled(&self, thread: &ThreadId, text: &str) -> String {
        self.store.redact_settled_text(thread.as_str(), text)
    }
}
/// [`super::seams::CloseIngest`] over the memory module's `ingest_session` action; `None` when
/// memory was not started this run. A session whose runtime never loaded the module (today's
/// `getMemoryModPromise()` returning null: no recall or memory call since it was opened) is not
/// ingested, its turns reach memory through the transcript watcher alone. The messages
/// go out with the session's sensitive values redacted, as its log is written
/// (`node-fix-memory-sensitive.patch`: 1.4.5 fed them in plain text).
pub struct MemoryCloseIngest {
    memory: Option<Arc<dyn mixdog_services::memory::service::MemoryModule>>,
    sensitive: Arc<mixdog_services::memory::sensitive::SensitiveStore>,
}
impl MemoryCloseIngest {
    /// Over the memory module the daemon started (`LocalMemory`), or `None` when memory is off.
    pub fn new(
        memory: Option<Arc<dyn mixdog_services::memory::service::MemoryModule>>,
        sensitive: Arc<mixdog_services::memory::sensitive::SensitiveStore>,
    ) -> Self {
        Self { memory, sensitive }
    }
}
impl super::seams::CloseIngest for MemoryCloseIngest {
    fn ingest(&self, id: &ThreadId, cwd: &str, messages: Vec<Value>) -> futures::future::BoxFuture<'static, ()> {
        let Some(memory) = self.memory.clone() else {
            return Box::pin(async {});
        };
        // Taken at every close, as the runtime that held the module ends with it.
        let loaded = memory.take_session_use(id.as_str());
        if !loaded || std::env::var("MIXDOG_DISABLE_MEMORY_INGEST").as_deref() == Ok("1") || messages.is_empty() {
            return Box::pin(async {});
        }
        // `session.cwd || getCurrentCwd()`.
        let cwd = if cwd.is_empty() { std::env::current_dir().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default() } else { cwd.to_owned() };
        let args = serde_json::json!({
            "action": "ingest_session",
            "sessionId": id.as_str(),
            "cwd": cwd,
            "messages": self.sensitive.redact_messages(id.as_str(), &messages),
        });
        Box::pin(async move {
            memory.memory(args).await;
        })
    }
}

/// The version of a log and the header members read of it at that version.
type PickedHeader = (u64, Option<Header>);
