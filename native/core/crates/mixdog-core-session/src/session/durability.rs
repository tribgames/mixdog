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
    Commit { result: Result<CommitDone, BarrierError>, generation: u64, units: Vec<Unit> },
    Retry(Result<RetryDone, BarrierError>),
    Redact(Result<(), BarrierError>),
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
