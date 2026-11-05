//! Keyed request serialization (P §7.1). Every method row declares its scope in the generated
//! method table; the scope resolved for one request is the key of one FIFO queue.
//!
//! - Exclusive requests of a key run one at a time, in arrival order.
//! - Leading shared reads of a key run together; a read behind an exclusive request waits for
//!   it, and an exclusive request waits for the reads before it.
//! - A queue lives only while it holds work, and requests of a connection that closed while
//!   queued are dropped at dequeue.
//!
//! Queues are independent. Each key owns its state behind its own lock; the sharded map only
//! finds or creates a key's cell, an O(1) lookup that runs no foreign code, so keys that share
//! a shard never share a queue lock. A key's lock covers the bookkeeping of that one queue and
//! nothing else: jobs are started, and cancelled jobs dropped, after it is released. Each
//! started request is its own task; there is no per-key driver task.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_app_protocol::SerializationScope;
use mixdog_rt::CancellationToken;
use mixdog_rt::TaskClass;

use crate::sharded::Sharded;
use crate::sharded::lock;

pub(crate) type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Access {
    Exclusive,
    SharedRead,
}

/// The queue a request joins. `global(k)` and `shared_read(k)` of one name are one queue, so
/// reads are ordered against writes.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum QueueKey {
    Global(&'static str),
    /// `channel:<client name>` of the calling connection.
    Channel(String),
    Scope(SerializationScope),
}

impl QueueKey {
    pub(crate) fn resolve(
        scope: SerializationScope,
        client_name: impl FnOnce() -> String,
    ) -> (Self, Access) {
        match scope {
            SerializationScope::Global(key) => (Self::Global(key), Access::Exclusive),
            SerializationScope::GlobalSharedRead(key) => (Self::Global(key), Access::SharedRead),
            SerializationScope::ChannelClient => (Self::Channel(client_name()), Access::Exclusive),
            other => (Self::Scope(other), Access::Exclusive),
        }
    }
}

struct Job {
    access: Access,
    cancel: CancellationToken,
    run: BoxFuture,
}

#[derive(Default)]
struct KeyState {
    waiting: VecDeque<Job>,
    running_shared: usize,
    running_exclusive: bool,
    /// Set, with the removal of the key's map entry, when the key went idle: a caller that
    /// still holds this cell finds a new one instead.
    retired: bool,
}

/// What one pass over a key's queue decided; acted on after the key's lock is released.
struct Step {
    ready: Vec<Job>,
    /// Jobs of closed connections, dropped unrun.
    cancelled: Vec<Job>,
}

#[derive(Default)]
struct KeyCell {
    state: Mutex<KeyState>,
}

impl KeyState {
    /// Takes every job that may start now and counts it as running.
    fn advance(&mut self) -> Step {
        let mut ready = Vec::new();
        let mut cancelled = Vec::new();
        while let Some(front) = self.waiting.front() {
            if front.cancel.is_cancelled() {
                cancelled.extend(self.waiting.pop_front());
                continue;
            }
            match front.access {
                Access::Exclusive => {
                    if self.running_shared == 0 && !self.running_exclusive {
                        self.running_exclusive = true;
                        ready.extend(self.waiting.pop_front());
                    }
                    break;
                }
                Access::SharedRead => {
                    if self.running_exclusive {
                        break;
                    }
                    self.running_shared += 1;
                    ready.extend(self.waiting.pop_front());
                }
            }
        }
        Step { ready, cancelled }
    }

    fn idle(&self) -> bool {
        self.waiting.is_empty() && self.running_shared == 0 && !self.running_exclusive
    }
}

#[derive(Clone)]
pub(crate) struct KeyedQueues {
    keys: Arc<Sharded<Arc<QueueKey>, Arc<KeyCell>>>,
}

impl KeyedQueues {
    pub(crate) fn new() -> Self {
        Self {
            keys: Arc::new(Sharded::new()),
        }
    }

    /// A map with `shards` shards: with one, every key collides with every other.
    #[cfg(test)]
    pub(crate) fn with_shards(shards: usize) -> Self {
        Self {
            keys: Arc::new(Sharded::with_shards(shards)),
        }
    }

    /// Queues `run` under `key`. `cancel` is the owning connection's token: a job whose token
    /// is cancelled before it starts is dropped unrun.
    pub(crate) fn enqueue(
        &self,
        key: QueueKey,
        access: Access,
        cancel: CancellationToken,
        run: BoxFuture,
    ) {
        let key = Arc::new(key);
        let mut job = Some(Job {
            access,
            cancel,
            run,
        });
        let (cell, step) = loop {
            let cell = self.cell(&key);
            let mut state = lock(&cell.state);
            if state.retired {
                continue;
            }
            state
                .waiting
                .push_back(job.take().expect("a job is queued once"));
            let step = self.advance(&key, &mut state);
            drop(state);
            break (cell, step);
        };
        self.act(&key, &cell, step);
    }

    /// The live cell of `key`, created if the key is idle. The shard lock is held for this
    /// lookup only.
    fn cell(&self, key: &Arc<QueueKey>) -> Arc<KeyCell> {
        Arc::clone(self.keys.shard(key).entry(Arc::clone(key)).or_default())
    }

    /// One pass over the queue, with the key's lock held by the caller. An idle key leaves
    /// the map in the same critical section (key lock, then shard lock; nothing takes them in
    /// the other order).
    fn advance(&self, key: &Arc<QueueKey>, state: &mut KeyState) -> Step {
        let step = state.advance();
        if state.idle() {
            state.retired = true;
            let removed = self.keys.shard(key).remove(key);
            drop(removed);
        }
        step
    }

    /// Runs what the key's lock was released for: drops cancelled jobs and starts the ready
    /// ones.
    fn act(&self, key: &Arc<QueueKey>, cell: &Arc<KeyCell>, step: Step) {
        drop(step.cancelled);
        for job in step.ready {
            let finished = Finished {
                queues: self.clone(),
                key: Arc::clone(key),
                cell: Arc::clone(cell),
                access: job.access,
            };
            mixdog_rt::spawn("serialized_request", TaskClass::Work, async move {
                let _finished = finished;
                if !job.cancel.is_cancelled() {
                    job.run.await;
                }
            });
        }
    }
}

/// Frees the running slot of a job when its task ends, however it ends, and starts what the
/// slot was blocking.
struct Finished {
    queues: KeyedQueues,
    key: Arc<QueueKey>,
    cell: Arc<KeyCell>,
    access: Access,
}

impl Drop for Finished {
    fn drop(&mut self) {
        let step = {
            let mut state = lock(&self.cell.state);
            match self.access {
                Access::Exclusive => state.running_exclusive = false,
                Access::SharedRead => state.running_shared -= 1,
            }
            self.queues.advance(&self.key, &mut state)
        };
        self.queues.act(&self.key, &self.cell, step);
    }
}
