//! Poll instrumentation (RL §13): a poll-time histogram per task name and class, and the list
//! of polls that exceeded their class bound.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering::Relaxed;
use std::time::Duration;

use arc_swap::ArcSwap;

use super::hist::HistSummary;
use super::hist::Histogram;
use crate::TaskClass;

/// Violations kept in full; further ones are only counted.
const VIOLATION_LOG_CAP: usize = 1024;

type TaskKey = (&'static str, TaskClass);

struct TaskStats {
    poll: Histogram,
    over_bound: AtomicU64,
}

/// One poll that ran longer than its class bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PollViolation {
    pub task: &'static str,
    pub class: TaskClass,
    pub elapsed: Duration,
}

/// Poll statistics of one task name.
#[derive(Clone, Copy, Debug)]
pub struct TaskSnapshot {
    pub task: &'static str,
    pub class: TaskClass,
    pub poll: HistSummary,
    /// Polls longer than `class.poll_bound()`.
    pub over_bound: u64,
}

pub(crate) struct TaskRegistry {
    // Read on every poll without a lock; replaced copy-on-write the first time a task name
    // appears.
    tasks: ArcSwap<HashMap<TaskKey, Arc<TaskStats>>>,
    violations: Mutex<Vec<PollViolation>>,
    violation_total: AtomicU64,
}

impl TaskRegistry {
    pub(crate) fn new() -> Self {
        Self {
            tasks: ArcSwap::from_pointee(HashMap::new()),
            violations: Mutex::new(Vec::new()),
            violation_total: AtomicU64::new(0),
        }
    }

    pub(crate) fn observe(&self, task: &'static str, class: TaskClass, elapsed: Duration) {
        let key = (task, class);
        let known = self.tasks.load();
        match known.get(&key) {
            Some(stats) => Self::record(stats, elapsed, task, class, self),
            None => {
                drop(known);
                self.tasks.rcu(|current| {
                    let mut next = HashMap::clone(current);
                    next.entry(key).or_insert_with(|| {
                        Arc::new(TaskStats {
                            poll: Histogram::new(),
                            over_bound: AtomicU64::new(0),
                        })
                    });
                    next
                });
                if let Some(stats) = self.tasks.load().get(&key) {
                    Self::record(stats, elapsed, task, class, self);
                }
            }
        }
    }

    fn record(
        stats: &TaskStats,
        elapsed: Duration,
        task: &'static str,
        class: TaskClass,
        registry: &TaskRegistry,
    ) {
        stats.poll.record(elapsed);
        if elapsed > class.poll_bound() {
            stats.over_bound.fetch_add(1, Relaxed);
            registry.violation_total.fetch_add(1, Relaxed);
            let mut log = registry
                .violations
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if log.len() < VIOLATION_LOG_CAP {
                log.push(PollViolation {
                    task,
                    class,
                    elapsed,
                });
            }
        }
    }

    pub(crate) fn snapshot(&self) -> Vec<TaskSnapshot> {
        let mut out: Vec<TaskSnapshot> = self
            .tasks
            .load()
            .iter()
            .map(|((task, class), stats)| TaskSnapshot {
                task,
                class: *class,
                poll: stats.poll.summary(),
                over_bound: stats.over_bound.load(Relaxed),
            })
            .collect();
        out.sort_by_key(|t| (t.task, t.class as u8));
        out
    }

    pub(crate) fn violations(&self) -> (Vec<PollViolation>, u64) {
        let log = self
            .violations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (log.clone(), self.violation_total.load(Relaxed))
    }
}
