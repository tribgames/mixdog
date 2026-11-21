//! `DurabilityTask`: the sole owner of one session's `SessionLog` (SM §8 state machine, I1,
//! SPEC R26). It receives encoded records from its actor in accept order, group-commits them
//! (one job in flight, at most `batch_bytes` per batch, RL §6.1) on io-durability, and sends
//! ordered acks back. The actor never awaits storage; this task never touches session state.
//!
//! Records arrive in units (one request's plan): a unit is committed whole in one batch, never split.
//! After a failed barrier every queued record of that generation is dropped and nothing is kept here: the actor's outbox
//! is the one owner of everything not yet durable, in accept order, and hands again what it keeps (see
//! [`super::outbox::Outbox::handoff`]). A second keeper here, writing its units ahead of what the actor hands, would put a
//! kept unit before records accepted ahead of it.
//!
//! Limits, as Node's: a kept unit lives in memory only, so a crash before the next write loses it; Node's recorder keeps a
//! failed batch the same way (`session-log-writer.mjs:1236-1242`, the bytes stay in `_unacked` for the next `_drain`, and
//! the session's messages in memory), so after the same sequence neither has the rows on disk. A unit is buffered whole:
//! its size is the request's (one inherited conversation, bounded by the heir's context fit, `inheritance.rs`
//! `fit_message`; one imported conversation; one room post), as Node holds the whole session in memory and writes one
//! `append` record of it (`session-log-writer.mjs` `_messageRecord`); there is no other per-request bound on either side.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::JobHandle;
use mixdog_rt::LaneToken;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

use super::seams::AppendPosition;
use super::seams::BarrierError;
use super::seams::CommitRecord;
use super::seams::SessionLog;
use super::seams::ThreadStore;

pub(crate) enum ToDurability {
    /// One unit: the records of one request's plan (or one record), `(entry id, record, bytes)` in order, committed together.
    Append { generation: u64, records: Vec<(u64, CommitRecord, usize)> },
    /// "Retry storage".
    Retry,
    /// A mark reached the thread with no record to commit (a mark carried from a session whose text it holds): the log
    /// is rewritten now, as a commit would rewrite it first ([`SessionLog::redact`]).
    Redact,
}

pub(crate) enum FromDurability {
    /// `(entry id, ordinal)` of every record of the batch, in order.
    Acked { generation: u64, ordinals: Vec<(u64, u64)> },
    Failed {
        generation: u64,
        /// Entry IDs of the attempted batch, excluding queued units dropped with its generation.
        entries: Vec<u64>,
        error: BarrierError,
    },
    /// Records wait behind an in-flight group commit (`durabilityPending`, RL §6.3).
    Pending(bool),
    /// Outcome of a retry; `Ok` means the writer is `Clean`.
    Retried(Result<(), BarrierError>),
    /// A [`ToDurability::Redact`] job ended (what it rewrote is on disk; a failure is tried again at the next barrier).
    Redacted,
}

/// How a retirement ended ([`Retirer::retire`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Retired {
    /// The writer closed and the catalog holds its log through its end, no longer marked for a writer.
    Clean,
    /// The activation never opened a writer: it marked nothing.
    Unopened,
    /// Not a clean retirement, and why: the session's mark stays, and the next start reads its log again.
    Kept(String),
}

/// The one request that ends a session's journal writer cleanly. Dropped unused, the task ends without retiring (a
/// channel that merely closed proves nothing of the writer) and the mark stays.
pub(crate) struct Retirer(oneshot::Sender<oneshot::Sender<Retired>>);

impl Retirer {
    /// Seals the task's append admission (a record not yet in its channel is refused), lets it finish every record it
    /// accepted, then closes the writer on io-durability and settles the catalog ([`SessionLog::retire`]). Resolves with
    /// the outcome, which the task acknowledges only once it is settled.
    pub(crate) async fn retire(self) -> Retired {
        let (ack, settled) = oneshot::channel();
        if self.0.send(ack).is_err() {
            return Retired::Kept("the durability task had ended".into());
        }
        settled.await.unwrap_or_else(|_| Retired::Kept("the durability task ended before it retired".into()))
    }
}

/// How the log is reached at the first write.
pub(crate) enum LogInit {
    /// Opened read-only; open-for-append at the first write.
    Open(AppendPosition),
    /// A new session: the first record is its `session` frame.
    Create,
}

enum Log {
    Init(LogInit),
    Ready(Box<dyn SessionLog>),
    /// The writer was lost (a job panicked): every later batch is indeterminate.
    Lost,
}

/// The writer's slot. Only the job in flight (one at a time) locks it, so the lock is never
/// contended; it exists so a job the lane refuses does not take the writer with it.
type Slot = Arc<Mutex<Log>>;
type CommitDone = Result<Vec<u64>, BarrierError>;
type RetryDone = Result<(), BarrierError>;

/// The one job in flight: queued on io-durability (a full queue is waited out, never refused) and run.
type InFlight = futures::future::BoxFuture<'static, Done>;

/// `job` queued on `lane`, waiting for room, and its result; `Err` when it did not end with one, naming why ([`unrun`]).
async fn queued<R: Send + 'static>(lane: DurabilityIo, job: impl FnOnce(&mixdog_rt::InLane<DurabilityIo>) -> R + Send + 'static) -> Result<R, BarrierError> {
    // The writer's own jobs: nothing cancels them, only the lane ending.
    let handle: Result<JobHandle<R>, _> = lane.submit_wait(&CancellationToken::new(), job).await;
    match handle {
        Ok(handle) => handle.await.map_err(|dropped| unrun(Unrun::Dropped(dropped))),
        Err(refused) => Err(unrun(Unrun::Refused(refused))),
    }
}

/// Why an io-durability job gave no result.
enum Unrun {
    Refused(mixdog_rt::SubmitWaitError),
    Dropped(mixdog_rt::JobDropped),
}

/// A job the io-durability lane gave no result for. One it never ran applied nothing: the batch fails, naming the cause.
/// One that was dropped while it may have run (a panic) is not known to have written nothing: indeterminate.
fn unrun(why: Unrun) -> BarrierError {
    use mixdog_rt::JobDropped;
    use mixdog_rt::SubmitWaitError;
    let cause = match why {
        Unrun::Refused(SubmitWaitError::Full(_)) => "laneFull",
        Unrun::Refused(SubmitWaitError::ShutDown(_)) | Unrun::Dropped(JobDropped::ShutDown) => "laneShutDown",
        Unrun::Refused(SubmitWaitError::Wedged(_)) | Unrun::Dropped(JobDropped::Wedged) => "laneWedged",
        Unrun::Refused(SubmitWaitError::Cancelled) | Unrun::Dropped(JobDropped::Cancelled) => "cancelled",
        Unrun::Dropped(JobDropped::NotStarted) => "laneNotStarted",
        Unrun::Dropped(JobDropped::Dropped) => return BarrierError::Indeterminate { io_kind: "writerLost".into(), cause: "jobDropped".into() },
    };
    BarrierError::failed(cause)
}

/// One unit of the queue: written whole in one commit, never split across two.
struct Unit {
    generation: u64,
    records: Vec<(u64, CommitRecord, usize)>,
}

impl Unit {
    fn bytes(&self) -> usize {
        self.records.iter().map(|(_, _, size)| size).sum()
    }
}

pub(crate) struct DurabilityTask {
    thread: ThreadId,
    store: Arc<dyn ThreadStore>,
    lane: DurabilityIo,
    batch_bytes: usize,
    log: Slot,
    rx: mpsc::Receiver<ToDurability>,
    tx: mpsc::Sender<FromDurability>,
    queue: VecDeque<Unit>,
    dropped_generation: Option<u64>,
    retry: bool,
    redact: bool,
    pending: bool,
    /// No record is admitted any more: the actor's channel closed, or a retirement closed it, and what it held was taken.
    sealed: bool,
    /// The retirement's request, until it comes ([`Self::retirer`]).
    retiring: Option<oneshot::Receiver<oneshot::Sender<Retired>>>,
    /// The retirement asked for, answered once it is settled.
    retire: Option<oneshot::Sender<Retired>>,
    /// A batch failed with nobody left to hand it again: its records are not in the log.
    unwritten: Option<String>,
}

fn lost() -> BarrierError {
    BarrierError::Indeterminate { io_kind: "writerLost".into(), cause: "writerLost".into() }
}

impl DurabilityTask {
    pub fn new(
        thread: ThreadId,
        store: Arc<dyn ThreadStore>,
        lane: DurabilityIo,
        batch_bytes: usize,
        init: LogInit,
        rx: mpsc::Receiver<ToDurability>,
        tx: mpsc::Sender<FromDurability>,
    ) -> Self {
        Self {
            thread,
            store,
            lane,
            batch_bytes,
            log: Arc::new(Mutex::new(Log::Init(init))),
            rx,
            tx,
            queue: VecDeque::new(),
            dropped_generation: None,
            retry: false,
            redact: false,
            pending: false,
            sealed: false,
            retiring: None,
            retire: None,
            unwritten: None,
        }
    }

    /// The request that retires this task's writer; without one the task ends when its actor's channel closes and
    /// everything accepted is finished, and retires nothing.
    pub(crate) fn retirer(&mut self) -> Retirer {
        let (ask, asked) = oneshot::channel();
        self.retiring = Some(asked);
        Retirer(ask)
    }

    pub async fn run(mut self) {
        let mut in_flight: Option<InFlight> = None;
        loop {
            self.start(&mut in_flight);
            let pending = in_flight.is_some() && !self.queue.is_empty();
            if pending != self.pending {
                self.pending = pending;
                // An actor that is gone reads no answer; what it had this task accept is finished all the same.
                let _ = self.tx.send(FromDurability::Pending(pending)).await;
            }
            // Sealed, with nothing in flight and nothing left to start: every accepted record is finished.
            if self.sealed && in_flight.is_none() {
                if let Some(settled) = self.retire.take() {
                    let _ = settled.send(self.retired().await);
                    return;
                }
                if self.retiring.is_none() {
                    return;
                }
            }
            tokio::select! {
                biased;
                done = wait(&mut in_flight), if in_flight.is_some() => {
                    in_flight = None;
                    self.finish(done).await;
                }
                msg = self.rx.recv(), if !self.sealed => match msg {
                    None => self.sealed = true,
                    Some(ToDurability::Append { generation, records }) => {
                        if self.dropped_generation.is_none_or(|dropped| generation > dropped) {
                            self.queue.push_back(Unit { generation, records });
                        }
                    }
                    Some(ToDurability::Retry) => self.retry = true,
                    Some(ToDurability::Redact) => self.redact = true,
                },
                asked = requested(&mut self.retiring), if self.retiring.is_some() => {
                    self.retiring = None;
                    if let Ok(settled) = asked {
                        // Admission is sealed here: what the channel already holds is still taken, nothing after it.
                        self.rx.close();
                        self.retire = Some(settled);
                    }
                }
            }
        }
    }

    /// The retirement itself, once sealed and idle: the writer leaves its slot for good.
    async fn retired(&mut self) -> Retired {
        if let Some(why) = self.unwritten.take() {
            return Retired::Kept(why);
        }
        if matches!(*lock(&self.log), Log::Init(_)) {
            return Retired::Unopened;
        }
        let slot = self.log.clone();
        let closed = queued(self.lane, move |lane| match std::mem::replace(&mut *lock(&slot), Log::Lost) {
            Log::Ready(writer) => Ok(writer.retire(lane)),
            Log::Init(_) | Log::Lost => Err(lost()),
        })
        .await;
        match closed.and_then(|closed| closed) {
            Ok(settled) => match settled.await {
                Ok(()) => Retired::Clean,
                Err(why) => Retired::Kept(why),
            },
            Err(error) => Retired::Kept(format!("{error:?}")),
        }
    }

    /// Starts the next job when none is in flight; it waits out a full io-durability queue.
    fn start(&mut self, in_flight: &mut Option<InFlight>) {
        if in_flight.is_some() {
            return;
        }
        if self.retry {
            let slot = self.log.clone();
            self.retry = false;
            let job = queued(self.lane, move |lane| match &mut *lock(&slot) {
                Log::Ready(writer) => writer.retry(lane),
                Log::Init(_) => Ok(()),
                Log::Lost => Err(lost()),
            });
            *in_flight = Some(Box::pin(async move { Done::Retry(job.await) }));
            return;
        }
        // A queued batch rewrites the log before it appends (`SessionLog::commit`); only an idle log needs a job of its own.
        if std::mem::take(&mut self.redact) && self.queue.is_empty() {
            let (store, thread, slot) = (self.store.clone(), self.thread.clone(), self.log.clone());
            let job = queued(self.lane, move |lane| redact(lane, &*store, &thread, &mut lock(&slot)));
            *in_flight = Some(Box::pin(async move { Done::Redact(job.await) }));
            return;
        }
        let Some(generation) = self.queue.front().map(|front| front.generation) else { return };
        let mut units: Vec<Unit> = Vec::new();
        let mut bytes = 0;
        while let Some(front) = self.queue.front() {
            // Whole units only; a unit larger than a batch is a batch of its own.
            if front.generation != generation || (!units.is_empty() && bytes + front.bytes() > self.batch_bytes) {
                break;
            }
            let unit = self.queue.pop_front().expect("front exists");
            bytes += unit.bytes();
            units.push(unit);
        }
        let batch: Vec<CommitRecord> = units.iter().flat_map(|unit| unit.records.iter().map(|(_, record, _)| record.clone())).collect();
        let store = self.store.clone();
        let thread = self.thread.clone();
        let slot = self.log.clone();
        // A full lane is waited out with the units taken: the records behind them queue here meanwhile, in order.
        let job = queued(self.lane, move |lane| {
            let mut log = lock(&slot);
            commit(lane, &*store, &thread, &mut log, &batch)
        });
        *in_flight = Some(Box::pin(async move { Done::Commit { result: job.await, generation, units } }));
    }

    /// Handles a finished job and tells the actor, if it is still there.
    async fn finish(&mut self, done: Done) {
        let msg = match done {
            Done::Commit { result, generation, units } => {
                // A job that never ran wrote nothing and left the writer in its slot: the batch fails as not applied,
                // naming the cause, and the writer takes the next batch (a lost writer failed every later turn).
                match result.and_then(|done| done) {
                    Ok(ordinals) => FromDurability::Acked {
                        generation,
                        ordinals: units.iter().flat_map(|unit| unit.records.iter().map(|(id, _, _)| *id)).zip(ordinals).collect(),
                    },
                    Err(error) => {
                        self.dropped_generation = Some(generation);
                        self.queue.retain(|unit| unit.generation > generation);
                        if self.sealed || self.retire.is_some() {
                            self.unwritten = Some(format!("a batch accepted before the writer retired was not written: {error:?}"));
                        }
                        let entries = units.iter().flat_map(|unit| unit.records.iter().map(|(id, _, _)| *id)).collect();
                        FromDurability::Failed { generation, entries, error }
                    }
                }
            }
            Done::Retry(result) => FromDurability::Retried(result.and_then(|done| done)),
            // An unrun rewrite left the log as it was; the mark's journal entry stays and the next start redoes it.
            Done::Redact(result) => {
                if let Err(error) = result {
                    tracing::warn!(thread = %self.thread, "the log's sensitive rewrite gave no result on the io-durability lane: {error:?}");
                }
                FromDurability::Redacted
            }
        };
        #[cfg(any(test, feature = "test-support"))]
        let failed = matches!(msg, FromDurability::Failed { .. });
        let _ = self.tx.send(msg).await;
        #[cfg(any(test, feature = "test-support"))]
        if failed && let Some(told) = FAILURE_SENT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
            let _ = told.send(());
        }
    }
}

/// Told once a failed barrier's outcome is in the actor's channel: a test holds the actor until then.
#[cfg(any(test, feature = "test-support"))]
pub(crate) static FAILURE_SENT: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

enum Done {
    Commit { result: Result<CommitDone, BarrierError>, generation: u64, units: Vec<Unit> },
    Retry(Result<RetryDone, BarrierError>),
    Redact(Result<(), BarrierError>),
}

async fn wait(in_flight: &mut Option<InFlight>) -> Done {
    in_flight.as_mut().expect("guarded by is_some").await
}

async fn requested(retiring: &mut Option<oneshot::Receiver<oneshot::Sender<Retired>>>) -> Result<oneshot::Sender<Retired>, oneshot::error::RecvError> {
    retiring.as_mut().expect("guarded by is_some").await
}

/// One io-durability job: the log's owed rewrite with nothing to append; a log not opened yet is opened for it (as at a
/// first write), one never created holds nothing.
fn redact(lane: &mixdog_rt::InLane<DurabilityIo>, store: &dyn ThreadStore, thread: &ThreadId, log: &mut Log) {
    match std::mem::replace(log, Log::Lost) {
        Log::Ready(mut writer) => {
            writer.redact(lane);
            *log = Log::Ready(writer);
        }
        Log::Init(LogInit::Open(at)) => match store.open_log(lane, thread, at) {
            Ok(mut writer) => {
                writer.redact(lane);
                *log = Log::Ready(writer);
            }
            // As a failed open at a first write: the writer is lost and the next batch fails indeterminate.
            Err(error) => tracing::warn!(%thread, "the log could not be opened for its sensitive rewrite: {error:?}"),
        },
        other => *log = other,
    }
}

/// One io-durability job: open or create the writer at the first write, then the barrier.
fn commit(lane: &mixdog_rt::InLane<DurabilityIo>, store: &dyn ThreadStore, thread: &ThreadId, log: &mut Log, batch: &[CommitRecord]) -> CommitDone {
    if let Log::Ready(writer) = log {
        return writer.commit(lane, batch);
    }
    match std::mem::replace(log, Log::Lost) {
        Log::Lost | Log::Ready(_) => Err(lost()),
        Log::Init(LogInit::Open(at)) => {
            let mut writer = store.open_log(lane, thread, at)?;
            let result = writer.commit(lane, batch);
            *log = Log::Ready(writer);
            result
        }
        Log::Init(LogInit::Create) => {
            let Some((first, rest)) = batch.split_first() else {
                *log = Log::Init(LogInit::Create);
                return Ok(Vec::new());
            };
            let (mut writer, ordinal) = match store.create_log(lane, thread, first) {
                Ok(created) => created,
                Err(error) => {
                    // Nothing was published: a later batch creates it again.
                    *log = Log::Init(LogInit::Create);
                    return Err(error);
                }
            };
            let result = if rest.is_empty() { Ok(Vec::new()) } else { writer.commit(lane, rest) };
            *log = Log::Ready(writer);
            result.map(|mut ordinals| {
                ordinals.insert(0, ordinal);
                ordinals
            })
        }
    }
}

fn lock(slot: &Slot) -> std::sync::MutexGuard<'_, Log> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The retirement of a session's writer over the real store (log writer, projector, index): what the index holds once a
/// runtime has left the directory.
#[cfg(test)]
mod retire_tests {
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::domain::mock::MockOwnership;
    use mixdog_store::sqlite::SqliteStore;

    use super::super::SessionDirectory;
    use super::super::SessionHandle;
    use super::super::StoreThreads;
    use super::super::testing::DataDir;
    use super::super::testing::Rig;
    use super::super::tests::echo;
    use super::super::tests::left_idle;
    use super::super::tests::settled_idle;
    use super::super::tests::start_thread;
    use super::super::tests::turn;
    use super::*;
    use crate::eventually_on;

    /// A directory over the real thread store of a fresh data folder, and the index handle that store writes through.
    async fn world() -> (DataDir, SqliteStore, Rig, SessionDirectory) {
        let (data, index, _, rig, directory) = world_over_threads().await;
        (data, index, rig, directory)
    }

    async fn index_of(data: &DataDir) -> SqliteStore {
        let tokens = mixdog_rt::testing::tokens();
        let root = data.path().to_path_buf();
        let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &CancellationToken::new(), move |lane| {
            SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
        data.index(index)
    }

    /// [`world`], with the thread store itself.
    async fn world_over_threads() -> (DataDir, SqliteStore, Arc<StoreThreads>, Rig, SessionDirectory) {
        let data = DataDir::default();
        let index = index_of(&data).await;
        let maintenance = mixdog_rt::testing::tokens().maintenance_io;
        let threads =
            Arc::new(StoreThreads::over_data_dir(data.path(), index.clone(), Arc::new(MockOwnership::default()), maintenance).await.expect("the thread store"));
        let rig = Rig::new();
        rig.set_script(echo());
        let directory = SessionDirectory::new(rig.deps_on(threads.clone()));
        (data, index, threads, rig, directory)
    }

    /// One turn, settled: its rows are durable and nothing of it is still to be written.
    async fn said(handle: &SessionHandle, prompt: &str, op: &str) {
        turn(handle, prompt, op).await;
        eventually_on!(&[&handle.cell.stepped], || settled_idle(handle).then_some(())).await;
    }

    /// The thread's last subscriber leaves and its idle delay passes: it has left the directory.
    async fn left(directory: &SessionDirectory, handle: &SessionHandle) {
        assert!(handle.cell.subscribing());
        handle.cell.subscribed(true);
        left_idle(handle).await;
        eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&handle.id).is_none().then_some(())).await;
    }

    /// What the next start would have to repair: the marked sessions, and any whose rows a missed projection left holed.
    async fn marked(index: &SqliteStore) -> Vec<String> {
        index.owed_repairs().await.expect("the index answers")
    }

    /// The message count of the session's list row, when the index answers for the session at all (`listed`): `None`
    /// while it is marked, behind its log or unknown.
    async fn listed_count(index: &SqliteStore, id: &str) -> Option<u64> {
        index.listed(id).await.expect("the index answers")?;
        let summary = index.summary(id).await.expect("the index answers")?;
        serde_json::from_str::<serde_json::Value>(&summary).expect("a list row")["messageCount"].as_u64()
    }

    /// An idle unload retires the session's writer: once the unload has settled, the session's last write is listed on the
    /// same index handle and no mark is left for the next start to repair. Loaded again and unloaded again, the same.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_idle_unload_leaves_the_session_listed_and_unmarked() {
        let (_data, index, _rig, directory) = world().await;
        let handle = start_thread(&directory).await;
        let id = handle.id.clone();
        said(&handle, "first", "op-1").await;
        assert_eq!(marked(&index).await, [id.as_str()], "marked while its writer is open");
        left(&directory, &handle).await;
        directory.unload_settled(&id).await;
        assert!(marked(&index).await.is_empty(), "the unload left the session marked");
        let first = listed_count(&index, id.as_str()).await.expect("the session is listed from the index");
        assert!(first > 0, "the listed row holds the turn the session wrote last");

        let again = directory.open_handle(&id, &CallContext::internal("test")).await.expect("the thread opens again");
        assert!(marked(&index).await.is_empty(), "a load that wrote nothing marks nothing");
        said(&again, "second", "op-2").await;
        assert_eq!(marked(&index).await, [id.as_str()]);
        assert_eq!(listed_count(&index, id.as_str()).await, None, "a marked session is not answered from the index");
        left(&directory, &again).await;
        directory.unload_settled(&id).await;
        assert!(marked(&index).await.is_empty());
        let second = listed_count(&index, id.as_str()).await.expect("the session is listed from the index");
        assert!(second > first, "the listed row holds the second turn: {second} messages after {first}");
    }

    /// How long a test watches something that must not happen while it holds the cause back.
    const HELD: std::time::Duration = std::time::Duration::from_millis(500);

    /// A thread opened again while the retirement of the runtime that just left is still unanswered (the index takes no
    /// projection): the open waits for it, and once it is answered the mark the new runtime's first write sets is its own.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_thread_reopened_at_once_keeps_the_mark_of_its_own_writer() {
        let (_data, index, threads, _rig, directory) = world_over_threads().await;
        let directory = Arc::new(directory);
        let handle = start_thread(&directory).await;
        let id = handle.id.clone();
        said(&handle, "first", "op-1").await;
        let (reached, held) = threads.hold_index();
        reached.await.expect("the projector holds");
        left(&directory, &handle).await;
        let mut opening = tokio::spawn({
            let (directory, id) = (directory.clone(), id.clone());
            async move { directory.open_handle(&id, &CallContext::internal("test")).await }
        });
        assert!(mixdog_rt::time::timeout(HELD, &mut opening).await.is_err(), "the thread opened before the earlier runtime's retirement settled");
        assert_eq!(marked(&index).await, [id.as_str()], "the retirement is still unanswered");
        drop(held);
        let again = opening.await.expect("the open ran").expect("the thread opens again");
        directory.unload_settled(&id).await;
        assert!(marked(&index).await.is_empty(), "the earlier runtime retired clean");
        said(&again, "second", "op-2").await;
        assert_eq!(marked(&index).await, [id.as_str()], "the new runtime's mark");
        left(&directory, &again).await;
        directory.unload_settled(&id).await;
        assert!(marked(&index).await.is_empty());
    }

    /// A shutdown that finds a runtime already unloading, its retirement unanswered: it waits for that retirement as it
    /// does for the writers it retires itself, past its wait for the close work, and returns once it has settled.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_shutdown_waits_for_the_retirement_of_a_runtime_already_unloading() {
        let (_data, index, threads, _rig, directory) = world_over_threads().await;
        let directory = Arc::new(directory);
        let handle = start_thread(&directory).await;
        let id = handle.id.clone();
        said(&handle, "first", "op-1").await;
        let (reached, held) = threads.hold_index();
        reached.await.expect("the projector holds");
        left(&directory, &handle).await;
        let mut stopping = tokio::spawn({
            let directory = directory.clone();
            async move { directory.shutdown().await }
        });
        // Past the shutdown's wait for the close work, so only the retirement can still hold it.
        let past_close_work = std::time::Duration::from_secs(4);
        assert!(
            mixdog_rt::time::timeout(past_close_work, &mut stopping).await.is_err(),
            "the shutdown returned before the unloading runtime's retirement settled"
        );
        assert_eq!(marked(&index).await, [id.as_str()]);
        drop(held);
        stopping.await.expect("the shutdown ran");
        assert!(marked(&index).await.is_empty(), "the shutdown returned with the session marked");
        assert!(listed_count(&index, id.as_str()).await.is_some_and(|count| count > 0), "the last write is listed");
    }

    /// A graceful shutdown retires the writer of every thread still loaded before it returns.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_shutdown_leaves_the_loaded_session_listed_and_unmarked() {
        let (_data, index, _rig, directory) = world().await;
        let handle = start_thread(&directory).await;
        let id = handle.id.clone();
        said(&handle, "first", "op-1").await;
        assert_eq!(marked(&index).await, [id.as_str()]);
        assert_eq!(listed_count(&index, id.as_str()).await, None, "a marked session is not answered from the index");
        directory.shutdown().await;
        assert!(marked(&index).await.is_empty(), "the shutdown left the session marked");
        assert!(listed_count(&index, id.as_str()).await.is_some_and(|count| count > 0), "the listed row holds the turn the session wrote last");
    }

    /// A shutdown cut off before a retirement settles (the index takes no projection, so the retirement cannot be answered,
    /// and whatever bounds the shutdown ends the wait): the session stays marked, and the next open of the index repairs it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_shutdown_cut_off_before_a_retirement_settles_leaves_the_session_marked_for_the_next_open() {
        let (data, index, threads, _rig, directory) = world_over_threads().await;
        let handle = start_thread(&directory).await;
        let id = handle.id.clone();
        said(&handle, "first", "op-1").await;
        let (reached, _held) = threads.hold_index();
        reached.await.expect("the projector holds");
        // The test's stand-in for the stop's budget, past the shutdown's own waits so the cut falls in the retirement's.
        let cut = mixdog_rt::time::timeout(std::time::Duration::from_secs(4), directory.shutdown()).await;
        assert!(cut.is_err(), "the shutdown returned with a retirement the index could not have answered");
        assert_eq!(marked(&index).await, [id.as_str()], "a retirement that did not settle cleared the mark");
        // The process ends here: the index closes with the retirement unanswered.
        index.close();
        let reopened = index_of(&data).await;
        reopened.reconciled().await.expect("the next open reconciles");
        assert!(marked(&reopened).await.is_empty(), "the next open left the session marked");
        assert!(listed_count(&reopened, id.as_str()).await.is_some_and(|count| count > 0), "the session is listed after its repair, with its last write");
    }
}

#[cfg(test)]
mod lane_cause_tests {
    use std::sync::mpsc as gate;
    use std::time::Duration;
    use std::time::Instant;

    use mixdog_rt::Backend;
    use mixdog_rt::LaneFull;
    use mixdog_rt::LaneKind;
    use mixdog_rt::LaneWedged;
    use mixdog_rt::TaskClass;
    use mixdog_rt::exec::PoolParams;
    use mixdog_rt::exec::RtConfig;

    use super::super::seams::EncodedRecord;
    use super::super::testing::MemStore;
    use super::*;

    /// Longer than any lane's lease.
    const PAST_ANY_LEASE: Duration = Duration::from_secs(601);
    /// Only detects a hung test.
    const WAIT: Duration = Duration::from_secs(60);

    fn session_record() -> (CommitRecord, usize) {
        let value = serde_json::json!({"k":"session","v":2,"id":"unrun","log_id":"4f1c2a9e0b7d3c5a6e8f9012","header":{"inline":{"title":"t"}}});
        let record: mixdog_store::schema::record::Record = serde_json::from_value(value).expect("a record");
        let encoded = EncodedRecord(mixdog_store::encode::encode_record(record.clone()).expect("encodes"));
        let bytes = encoded.bytes();
        (CommitRecord { record: Arc::new(record), encoded }, bytes)
    }

    fn not_applied(cause: &str) -> BarrierError {
        BarrierError::failed(cause)
    }

    /// A batch admitted on io-durability and drained when the lane loses its last healthy worker, then a retry the
    /// wedged lane refuses: both fail as not applied naming the wedge (never `laneFull`), and nothing reaches the store.
    #[test]
    fn a_batch_and_a_retry_the_wedged_lane_never_ran_fail_not_applied_naming_the_wedge() {
        let mut config = RtConfig::for_cores(8);
        config.durability_io = PoolParams::fixed(1, 2, 3);
        let (executors, tokens) = mixdog_rt::exec::boot(config).expect("boot");
        let rt = executors.handle(TaskClass::Work);
        let lane = tokens.durability_io;
        let never = CancellationToken::new();
        let (started_tx, started) = gate::channel::<()>();
        let hold = |release: gate::Receiver<()>| {
            let started = started_tx.clone();
            lane.submit(&never, move |_| {
                started.send(()).unwrap();
                let _ = release.recv_timeout(WAIT);
            })
            .unwrap()
        };
        // The only worker is stuck, then its replacement: the next sweep leaves no healthy worker.
        let (release_a, a_gate) = gate::channel();
        let a = hold(a_gate);
        started.recv_timeout(WAIT).expect("the first stuck job starts");
        executors.sweep_leases(Instant::now() + PAST_ANY_LEASE);
        let (release_b, b_gate) = gate::channel();
        let b = hold(b_gate);
        started.recv_timeout(WAIT).expect("the replacement's stuck job starts");

        let store = Arc::new(MemStore::default());
        let thread = ThreadId::from("unrun-batch");
        let (to_tx, to_rx) = mpsc::channel(8);
        let (from_tx, mut from_rx) = mpsc::channel(8);
        let task = DurabilityTask::new(thread.clone(), store.clone(), lane, 1 << 20, LogInit::Create, to_rx, from_tx);
        let _task = rt.spawn(task.run());
        let (record, bytes) = session_record();
        rt.block_on(to_tx.send(ToDurability::Append { generation: 1, records: vec![(1, record, bytes)] })).unwrap();
        let deadline = Instant::now() + WAIT;
        while executors.diagnostics().lanes.iter().find(|l| l.kind == LaneKind::DurabilityIo).unwrap().queue_depth == 0 {
            assert!(Instant::now() < deadline, "the batch's job reaches the lane");
            std::thread::yield_now();
        }

        executors.sweep_leases(Instant::now() + PAST_ANY_LEASE);
        let next = |from_rx: &mut mpsc::Receiver<FromDurability>| loop {
            match rt.block_on(async { mixdog_rt::time::timeout(WAIT, from_rx.recv()).await }).expect("the task answers").expect("open") {
                FromDurability::Pending(_) => continue,
                other => break other,
            }
        };
        match next(&mut from_rx) {
            FromDurability::Failed { generation, entries, error } => {
                assert_eq!((generation, entries, error), (1, vec![1], not_applied("laneWedged")));
            }
            _ => panic!("the batch fails"),
        }
        rt.block_on(to_tx.send(ToDurability::Retry)).unwrap();
        match next(&mut from_rx) {
            FromDurability::Retried(result) => assert_eq!(result, Err(not_applied("laneWedged"))),
            _ => panic!("the retry answers"),
        }
        assert!(store.log_ids().is_empty(), "no write reached the store");

        drop((release_a, release_b));
        rt.block_on(async {
            assert_eq!(a.await, Ok(()));
            assert_eq!(b.await, Ok(()));
        });
    }

    /// Each way the lane gives no result reaches the actor as its own cause; a job that may have run is indeterminate.
    #[test]
    fn every_unrun_cause_reaches_the_actor_and_a_lost_result_stays_indeterminate() {
        use mixdog_rt::JobDropped;
        use mixdog_rt::SubmitWaitError;
        let lane = LaneKind::DurabilityIo;
        let cases = [
            (Unrun::Refused(SubmitWaitError::ShutDown(lane)), not_applied("laneShutDown")),
            (Unrun::Dropped(JobDropped::ShutDown), not_applied("laneShutDown")),
            (Unrun::Refused(SubmitWaitError::Wedged(LaneWedged { lane })), not_applied("laneWedged")),
            (Unrun::Dropped(JobDropped::Wedged), not_applied("laneWedged")),
            (Unrun::Refused(SubmitWaitError::Cancelled), not_applied("cancelled")),
            (Unrun::Dropped(JobDropped::Cancelled), not_applied("cancelled")),
            (Unrun::Dropped(JobDropped::NotStarted), not_applied("laneNotStarted")),
            (Unrun::Refused(SubmitWaitError::Full(LaneFull { lane })), not_applied("laneFull")),
            (Unrun::Dropped(JobDropped::Dropped), BarrierError::Indeterminate { io_kind: "writerLost".into(), cause: "jobDropped".into() }),
        ];
        for (why, error) in cases {
            assert_eq!(unrun(why), error);
        }
    }
}
