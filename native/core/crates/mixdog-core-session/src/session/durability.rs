//! `DurabilityTask`: the sole owner of one session's `SessionLog` (SM §8 state machine, I1,
//! SPEC R26). It receives encoded records from its actor in accept order, group-commits them
//! (one job in flight, at most `batch_bytes` per batch, RL §6.1) on io-durability, and sends
//! ordered acks back. The actor never awaits storage; this task never touches session state.
//!
//! Records arrive in units (one request's plan): a unit is committed whole in one batch, never split.
//! After a failed barrier every queued record of that generation is dropped: the actor fails
//! them all, resets its projected state and continues with the next generation — except the
//! retained units of a write that was rolled back cleanly, which wait to go first with the next write.
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
        /// A failed write keeps the unit for the next one.
        retain: bool,
        records: Vec<(u64, CommitRecord, usize)>,
    },
    /// The units kept from a failed write go now, with nothing new (the thread is closing).
    Flush { generation: u64 },
    /// "Retry storage".
    Retry,
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
        /// The entry ids of the units kept, in order, to go with the next write (a rolled-back write of retained units).
        retained: Vec<u64>,
    },
    /// Records wait behind an in-flight group commit (`durabilityPending`, RL §6.3).
    Pending(bool),
    /// Outcome of a retry; `Ok` means the writer is `Clean`.
    Retried(Result<(), BarrierError>),
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

/// One unit of the queue: written whole in one commit, never split across two.
#[derive(Clone)]
struct Unit {
    generation: u64,
    retain: bool,
    records: Vec<(u64, CommitRecord, usize)>,
}

impl Unit {
    fn bytes(&self) -> usize {
        self.records.iter().map(|(_, _, size)| size).sum()
    }
}

enum InFlight {
    Commit {
        handle: JobHandle<CommitDone>,
        generation: u64,
        units: Vec<Unit>,
    },
    Retry(JobHandle<RetryDone>),
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
    /// Units of a write that failed and was rolled back, kept in order to go first with the next write (Node's recorder
    /// keeps a failed batch's bytes and writes them again with the next one, `session-log-writer.mjs` `_drain`).
    held: Vec<Unit>,
    /// The held units go now with nothing new, under this generation.
    flush: Option<u64>,
    dropped_generation: Option<u64>,
    retry: bool,
    pending: bool,
}

fn lost() -> BarrierError {
    BarrierError::Indeterminate {
        io_kind: "writerLost".into(),
    }
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
            held: Vec::new(),
            flush: None,
            dropped_generation: None,
            retry: false,
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
                    Some(ToDurability::Append { generation, retain, records }) => {
                        if self.dropped_generation.is_none_or(|dropped| generation > dropped) {
                            self.queue.push_back(Unit { generation, retain, records });
                        }
                    }
                    Some(ToDurability::Flush { generation }) => self.flush = Some(generation),
                    Some(ToDurability::Retry) => self.retry = true,
                },
            }
        }
    }

    /// Submits the next job when none is in flight. A full io-durability queue leaves the work
    /// queued; the next message or completion tries again.
    fn start(&mut self, in_flight: &mut Option<InFlight>) {
        if in_flight.is_some() {
            return;
        }
        if self.retry {
            let slot = self.log.clone();
            let submitted = self.lane.submit(&CancellationToken::new(), move |lane| {
                match &mut *lock(&slot) {
                    Log::Ready(writer) => writer.retry(lane),
                    Log::Init(_) => Ok(()),
                    Log::Lost => Err(lost()),
                }
            });
            if let Ok(handle) = submitted {
                self.retry = false;
                *in_flight = Some(InFlight::Retry(handle));
            }
            return;
        }
        // Held units wait for the next write (a new unit) or a flush.
        let generation = match (self.queue.front(), self.flush) {
            (Some(front), _) => front.generation,
            (None, Some(generation)) if !self.held.is_empty() => generation,
            _ => return,
        };
        // The held units go first, under the generation of the write they go with.
        let mut units: Vec<Unit> = std::mem::take(&mut self.held);
        for unit in &mut units {
            unit.generation = generation;
        }
        let mut bytes: usize = units.iter().map(Unit::bytes).sum();
        let mut fresh = 0;
        while let Some(front) = self.queue.front() {
            // Whole units only; a unit larger than a batch is a batch of its own.
            if front.generation != generation || (fresh > 0 && bytes + front.bytes() > self.batch_bytes) {
                break;
            }
            let unit = self.queue.pop_front().expect("front exists");
            bytes += unit.bytes();
            fresh += 1;
            units.push(unit);
        }
        let flushing = self.flush.take();
        let batch: Vec<CommitRecord> = units.iter().flat_map(|unit| unit.records.iter().map(|(_, record, _)| record.clone())).collect();
        let store = self.store.clone();
        let thread = self.thread.clone();
        let slot = self.log.clone();
        let submitted = self.lane.submit(&CancellationToken::new(), move |lane| {
            let mut log = lock(&slot);
            commit(lane, &*store, &thread, &mut log, &batch)
        });
        match submitted {
            Ok(handle) => *in_flight = Some(InFlight::Commit { handle, generation, units }),
            Err(_) => {
                // The lane is full: the units go back where they were, in order.
                let fresh_units = units.split_off(units.len() - fresh);
                self.held = units;
                for unit in fresh_units.into_iter().rev() {
                    self.queue.push_front(unit);
                }
                self.flush = flushing;
            }
        }
    }

    /// Handles a finished job; `false` when the actor is gone.
    async fn finish(&mut self, done: Done) -> bool {
        let msg = match done {
            Done::Commit {
                result,
                generation,
                units,
            } => {
                let result = result.unwrap_or_else(|_| {
                    *lock(&self.log) = Log::Lost;
                    Err(lost())
                });
                match result {
                    Ok(ordinals) => FromDurability::Acked {
                        generation,
                        ordinals: units.iter().flat_map(|unit| unit.records.iter().map(|(id, _, _)| *id)).zip(ordinals).collect(),
                    },
                    Err(error) => {
                        self.dropped_generation = Some(generation);
                        self.queue.retain(|unit| unit.generation > generation);
                        // A write rolled back cleanly keeps its retained units for the next write; one whose outcome is
                        // unknown keeps nothing.
                        if matches!(error, BarrierError::Failed { .. }) {
                            self.held = units.into_iter().filter(|unit| unit.retain).collect();
                        }
                        let retained = self.held.iter().flat_map(|unit| unit.records.iter().map(|(id, _, _)| *id)).collect();
                        FromDurability::Failed { generation, error, retained }
                    }
                }
            }
            Done::Retry(result) => {
                let result = result.unwrap_or_else(|_| {
                    *lock(&self.log) = Log::Lost;
                    Err(lost())
                });
                FromDurability::Retried(result)
            }
        };
        self.tx.send(msg).await.is_ok()
    }
}

enum Done {
    Commit {
        result: Result<CommitDone, mixdog_rt::JobDropped>,
        generation: u64,
        units: Vec<Unit>,
    },
    Retry(Result<RetryDone, mixdog_rt::JobDropped>),
}

async fn wait(in_flight: &mut Option<InFlight>) -> Done {
    match in_flight.as_mut().expect("guarded by is_some") {
        InFlight::Commit {
            handle,
            generation,
            units,
        } => {
            let result = handle.await;
            Done::Commit {
                result,
                generation: *generation,
                units: std::mem::take(units),
            }
        }
        InFlight::Retry(handle) => Done::Retry(handle.await),
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
