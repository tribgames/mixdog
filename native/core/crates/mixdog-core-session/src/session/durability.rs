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

use super::seams::AppendPosition;
use super::seams::BarrierError;
use super::seams::CommitRecord;
use super::seams::SessionLog;
use super::seams::ThreadStore;

pub(crate) enum ToDurability {
    /// One unit: the records of one request's plan (or one record), `(entry id, record, bytes)` in order, committed together.
    Append {
        generation: u64,
        records: Vec<(u64, CommitRecord, usize)>,
    },
    /// "Retry storage".
    Retry,
    /// A mark reached the thread with no record to commit (a mark carried from a session whose text it holds): the log
    /// is rewritten now, as a commit would rewrite it first ([`SessionLog::redact`]).
    Redact,
}

pub(crate) enum FromDurability {
    /// `(entry id, ordinal)` of every record of the batch, in order.
    Acked {
        generation: u64,
        ordinals: Vec<(u64, u64)>,
    },
    Failed {
        generation: u64,
        error: BarrierError,
    },
    /// Records wait behind an in-flight group commit (`durabilityPending`, RL §6.3).
    Pending(bool),
    /// Outcome of a retry; `Ok` means the writer is `Clean`.
    Retried(Result<(), BarrierError>),
    /// A [`ToDurability::Redact`] job ended (what it rewrote is on disk; a failure is tried again at the next barrier).
    Redacted,
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

/// `job` queued on `lane`, waiting for room, and its result; `Err` when it can never run (the lane has no healthy worker),
/// which the task treats as a job that was dropped unrun.
fn queued<R: Send + 'static>(
    lane: DurabilityIo,
    job: impl FnOnce(&mixdog_rt::InLane<DurabilityIo>) -> R + Send + 'static,
) -> impl Future<Output = Result<R, mixdog_rt::JobDropped>> + Send + 'static {
    async move {
    let handle: Result<JobHandle<R>, _> = lane.submit_wait(&CancellationToken::new(), job).await;
    match handle {
        Ok(handle) => handle.await,
        Err(error) => {
            tracing::warn!("an io-durability job could not be queued: {error:?}");
            Err(match error {
                mixdog_rt::SubmitWaitError::ShutDown(_) => mixdog_rt::JobDropped::ShutDown,
                _ => mixdog_rt::JobDropped::Dropped,
            })
        }
    }
    }
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
}

fn lost() -> BarrierError {
    BarrierError::Indeterminate {
        io_kind: "writerLost".into(),
        cause: "writerLost".into(),
    }
}

/// A job the io-durability lane never ran: nothing of it was applied.
fn unrun() -> BarrierError {
    BarrierError::failed("laneFull")
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
        }
    }

    pub async fn run(mut self) {
        let mut in_flight: Option<InFlight> = None;
        loop {
            self.start(&mut in_flight);
            let pending = in_flight.is_some() && !self.queue.is_empty();
            if pending != self.pending {
                self.pending = pending;
                if self.tx.send(FromDurability::Pending(pending)).await.is_err() {
                    return;
                }
            }
            tokio::select! {
                biased;
                done = wait(&mut in_flight), if in_flight.is_some() => {
                    in_flight = None;
                    if !self.finish(done).await {
                        return;
                    }
                }
                msg = self.rx.recv() => match msg {
                    None => return,
                    Some(ToDurability::Append { generation, records }) => {
                        if self.dropped_generation.is_none_or(|dropped| generation > dropped) {
                            self.queue.push_back(Unit { generation, records });
                        }
                    }
                    Some(ToDurability::Retry) => self.retry = true,
                    Some(ToDurability::Redact) => self.redact = true,
                },
            }
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

    /// Handles a finished job; `false` when the actor is gone.
    async fn finish(&mut self, done: Done) -> bool {
        let msg = match done {
            Done::Commit {
                result,
                generation,
                units,
            } => {
                // A job that never ran wrote nothing and left the writer in its slot: the batch fails as not applied,
                // naming the lane, and the writer takes the next batch (a lost writer failed every later turn).
                let result = result.unwrap_or_else(|_| Err(unrun()));
                match result {
                    Ok(ordinals) => FromDurability::Acked {
                        generation,
                        ordinals: units.iter().flat_map(|unit| unit.records.iter().map(|(id, _, _)| *id)).zip(ordinals).collect(),
                    },
                    Err(error) => {
                        self.dropped_generation = Some(generation);
                        self.queue.retain(|unit| unit.generation > generation);
                        FromDurability::Failed { generation, error }
                    }
                }
            }
            Done::Retry(result) => FromDurability::Retried(result.unwrap_or_else(|_| Err(unrun()))),
            // An unrun rewrite left the log as it was; the mark's journal entry stays and the next start redoes it.
            Done::Redact(result) => {
                if result.is_err() {
                    tracing::warn!(thread = %self.thread, "the log's sensitive rewrite never ran: the io-durability lane could not take it");
                }
                FromDurability::Redacted
            }
        };
        #[cfg(any(test, feature = "test-support"))]
        let failed = matches!(msg, FromDurability::Failed { .. });
        let sent = self.tx.send(msg).await.is_ok();
        #[cfg(any(test, feature = "test-support"))]
        if failed && let Some(told) = FAILURE_SENT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
            let _ = told.send(());
        }
        sent
    }
}

/// Told once a failed barrier's outcome is in the actor's channel: a test holds the actor until then.
#[cfg(any(test, feature = "test-support"))]
pub(crate) static FAILURE_SENT: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

enum Done {
    Commit {
        result: Result<CommitDone, mixdog_rt::JobDropped>,
        generation: u64,
        units: Vec<Unit>,
    },
    Retry(Result<RetryDone, mixdog_rt::JobDropped>),
    Redact(Result<(), mixdog_rt::JobDropped>),
}

async fn wait(in_flight: &mut Option<InFlight>) -> Done {
    in_flight.as_mut().expect("guarded by is_some").await
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
fn commit(
    lane: &mixdog_rt::InLane<DurabilityIo>,
    store: &dyn ThreadStore,
    thread: &ThreadId,
    log: &mut Log,
    batch: &[CommitRecord],
) -> CommitDone {
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
            let result = if rest.is_empty() {
                Ok(Vec::new())
            } else {
                writer.commit(lane, rest)
            };
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
