//! `DurabilityTask`: the sole owner of one session's `SessionLog` (SM §8 state machine, I1,
//! SPEC R26). It receives encoded records from its actor in accept order, group-commits them
//! (one job in flight, at most `batch_bytes` per batch, RL §6.1) on io-durability, and sends
//! ordered acks back. The actor never awaits storage; this task never touches session state.
//!
//! After a failed barrier every queued record of that generation is dropped: the actor fails
//! them all, resets its projected state and continues with the next generation.

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
    Append {
        id: u64,
        generation: u64,
        record: CommitRecord,
        bytes: usize,
    },
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

enum InFlight {
    Commit {
        handle: JobHandle<CommitDone>,
        generation: u64,
        ids: Vec<u64>,
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
    queue: VecDeque<(u64, u64, CommitRecord, usize)>,
    dropped_generation: Option<u64>,
    retry: bool,
    pending: bool,
}

fn lost() -> BarrierError {
    BarrierError::Indeterminate {
        io_kind: "writerLost".into(),
        cause: "writerLost".into(),
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
                    Some(ToDurability::Append { id, generation, record, bytes }) => {
                        if self.dropped_generation.is_none_or(|dropped| generation > dropped) {
                            self.queue.push_back((id, generation, record, bytes));
                        }
                    }
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
        if self.queue.is_empty() {
            return;
        }
        let generation = self.queue[0].1;
        let mut ids = Vec::new();
        let mut batch = Vec::new();
        let mut bytes = 0;
        while let Some((_, g, _, size)) = self.queue.front() {
            if *g != generation || (!batch.is_empty() && bytes + size > self.batch_bytes) {
                break;
            }
            let (id, _, record, size) = self.queue.pop_front().expect("front exists");
            bytes += size;
            ids.push(id);
            batch.push(record);
        }
        let store = self.store.clone();
        let thread = self.thread.clone();
        let slot = self.log.clone();
        let restore = batch.clone();
        let submitted = self.lane.submit(&CancellationToken::new(), move |lane| {
            let mut log = lock(&slot);
            commit(lane, &*store, &thread, &mut log, &batch)
        });
        match submitted {
            Ok(handle) => {
                *in_flight = Some(InFlight::Commit {
                    handle,
                    generation,
                    ids,
                })
            }
            Err(_) => {
                // The lane is full: the batch goes back to the front, in order.
                for (id, record) in ids.into_iter().zip(restore).rev() {
                    let size = record.encoded.bytes();
                    self.queue.push_front((id, generation, record, size));
                }
            }
        }
    }

    /// Handles a finished job; `false` when the actor is gone.
    async fn finish(&mut self, done: Done) -> bool {
        let msg = match done {
            Done::Commit {
                result,
                generation,
                ids,
            } => {
                let result = result.unwrap_or_else(|_| {
                    *lock(&self.log) = Log::Lost;
                    Err(lost())
                });
                match result {
                    Ok(ordinals) => FromDurability::Acked {
                        generation,
                        ordinals: ids.into_iter().zip(ordinals).collect(),
                    },
                    Err(error) => {
                        self.dropped_generation = Some(generation);
                        self.queue.retain(|(_, g, _, _)| *g > generation);
                        FromDurability::Failed { generation, error }
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
        #[cfg(test)]
        let failed = matches!(msg, FromDurability::Failed { .. });
        let sent = self.tx.send(msg).await.is_ok();
        #[cfg(test)]
        if failed && let Some(told) = FAILURE_SENT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
            let _ = told.send(());
        }
        sent
    }
}

/// Told once a failed barrier's outcome is in the actor's channel: a test holds the actor until then.
#[cfg(test)]
pub(crate) static FAILURE_SENT: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

enum Done {
    Commit {
        result: Result<CommitDone, mixdog_rt::JobDropped>,
        generation: u64,
        ids: Vec<u64>,
    },
    Retry(Result<RetryDone, mixdog_rt::JobDropped>),
}

async fn wait(in_flight: &mut Option<InFlight>) -> Done {
    match in_flight.as_mut().expect("guarded by is_some") {
        InFlight::Commit {
            handle,
            generation,
            ids,
        } => {
            let result = handle.await;
            Done::Commit {
                result,
                generation: *generation,
                ids: std::mem::take(ids),
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
