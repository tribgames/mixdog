use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;

use mixdog_store::projection::FrameKind;
use mixdog_store::projection::Projection;

use super::store::LogShape;

#[derive(Default)]
struct Thread {
    /// Which entry of the thread this is ([`ContextLens::forget`] removes one, and the next starts anew).
    entry: u64,
    /// The batches of the thread's writer that have ended.
    batches: u64,
    /// The thread's writer is inside a batch.
    writing: bool,
    /// Forgotten while its writer was inside a batch: the entry goes when that batch ends.
    forgotten: bool,
    kept: Option<(Arc<LogShape>, usize)>,
}

impl Thread {
    /// The kept length, dropped once its shape no longer stands.
    fn standing(&mut self) -> Option<usize> {
        let (shape, len) = self.kept.as_ref()?;
        if shape.stands() {
            return Some(*len);
        }
        self.kept = None;
        None
    }

    fn ended(&mut self) {
        self.batches += 1;
        self.writing = false;
    }
}

/// By thread, while the thread is loaded or read; [`forget`](ContextLens::forget) removes an entry once nothing writes it.
/// A count in progress compares the entry and its batches with those it began at, so a count over a removed entry is not kept.
#[derive(Default)]
pub(super) struct ContextLens {
    threads: Mutex<HashMap<String, Thread>>,
    entries: std::sync::atomic::AtomicU64,
}

/// A count of a thread's context being taken: where the thread's batches stood when it began.
pub(super) struct Counting {
    entry: u64,
    batches: u64,
    kept: Option<usize>,
}

impl Counting {
    /// The length kept when the count began: what the index counts once it holds the batches stored by then.
    pub(super) fn kept(&self) -> Option<usize> {
        self.kept
    }
}

/// The thread's writer inside one batch. Dropped without [`stored`](Self::stored), the batch failed: what its log holds
/// is not known, and what was kept of the thread is dropped.
pub(super) struct Batch {
    lens: Arc<ContextLens>,
    thread: String,
    stored: bool,
}

impl Batch {
    /// The batch is in the log. `send` hands its projection to the index writer in the step that adds `growth` and ends
    /// the batch: a count sees all of it or none.
    pub(super) fn stored(mut self, growth: Growth, send: impl FnOnce()) {
        let mut threads = self.lens.threads();
        send();
        if let Some(state) = threads.get_mut(&self.thread) {
            state.ended();
            if let Some((_, len)) = &mut state.kept {
                *len = growth.restart.unwrap_or(*len) + growth.added;
            }
            if state.forgotten {
                threads.remove(&self.thread);
            }
        }
        drop(threads);
        self.stored = true;
    }
}

impl Drop for Batch {
    fn drop(&mut self) {
        if self.stored {
            return;
        }
        let mut threads = self.lens.threads();
        if let Some(state) = threads.get_mut(&self.thread) {
            state.ended();
            state.kept = None;
            if state.forgotten {
                threads.remove(&self.thread);
            }
        }
    }
}

/// What one batch does to the length of its thread's context.
pub(super) struct Growth {
    /// The rows of the batch's newest compaction: the context starts again at them.
    restart: Option<usize>,
    /// The model messages after that.
    added: usize,
}

impl Growth {
    /// As the index writer applies `batch`: a model message is one row, an amend replaces a row's version, a compaction's
    /// replacement is the context from there on.
    pub(super) fn of(batch: &Projection) -> Self {
        let mut growth = Self { restart: None, added: 0 };
        for frame in &batch.frames {
            match &frame.kind {
                FrameKind::Item { msg: Some(_), .. } => growth.added += 1,
                FrameKind::Compacted { rows, .. } => growth = Self { restart: Some(rows.len()), added: 0 },
                _ => {}
            }
        }
        growth
    }
}

impl ContextLens {
    fn threads(&self) -> MutexGuard<'_, HashMap<String, Thread>> {
        self.threads.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `thread`'s entry, made anew when it has none.
    fn entry<'a>(&self, threads: &'a mut HashMap<String, Thread>, thread: &str) -> &'a mut Thread {
        threads
            .entry(thread.to_owned())
            .or_insert_with(|| Thread { entry: self.entries.fetch_add(1, std::sync::atomic::Ordering::Relaxed), ..Thread::default() })
    }

    /// The length of `thread`'s context as it is kept now.
    pub(super) fn kept(&self, thread: &str) -> Option<usize> {
        self.threads().get_mut(thread)?.standing()
    }

    /// Begins a count of `thread`'s context. Taken before the wait for the index: every batch stored before this is in
    /// the index after that wait.
    pub(super) fn counting(&self, thread: &str) -> Counting {
        let mut threads = self.threads();
        let state = self.entry(&mut threads, thread);
        Counting { entry: state.entry, batches: state.batches, kept: state.standing() }
    }

    /// Keeps `len`, counted from the index over `shape` since `counting`. Not when the thread's writer is inside a batch
    /// or ended one meanwhile, or the entry the count began on was forgotten: the log the shape was read from and the
    /// index the rows were counted in may then lie on either side of a batch.
    pub(super) fn keep(&self, thread: &str, counting: Counting, shape: &Arc<LogShape>, len: usize) {
        let mut threads = self.threads();
        let Some(state) = threads.get_mut(thread) else { return };
        if state.entry == counting.entry && !state.writing && state.batches == counting.batches && shape.stands() {
            state.kept = Some((shape.clone(), len));
        }
    }

    /// `thread`'s writer begins a batch, before it touches the thread's log.
    pub(super) fn batch(self: &Arc<Self>, thread: &str) -> Batch {
        let mut threads = self.threads();
        let state = self.entry(&mut threads, thread);
        state.writing = true;
        state.forgotten = false;
        Batch { lens: self.clone(), thread: thread.to_owned(), stored: false }
    }

    /// `thread` was unloaded or deleted: its entry goes now, or when the batch its writer is inside ends.
    pub(super) fn forget(&self, thread: &str) {
        let mut threads = self.threads();
        match threads.get_mut(thread) {
            Some(state) if state.writing => state.forgotten = true,
            Some(_) => drop(threads.remove(thread)),
            None => {}
        }
    }

    #[cfg(test)]
    pub(super) fn holds(&self, thread: &str) -> bool {
        self.threads().contains_key(thread)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A count is kept only when the thread's writer ran no batch beside it: one stored between the count's start and
    /// its end may or may not be among the rows counted, and one in the log and not yet with the index is in the shape
    /// and not in the rows. A kept count takes each later batch once; a batch that failed drops it.
    #[test]
    fn a_count_is_kept_only_when_no_batch_of_the_thread_ran_beside_it() {
        let lens = Arc::new(ContextLens::default());
        let shape = LogShape::of_no_log();
        let adds = |added| Growth { restart: None, added };

        let counting = lens.counting("t");
        lens.batch("t").stored(adds(1), || {});
        lens.keep("t", counting, &shape, 1);
        assert_eq!(lens.kept("t"), None, "a batch was stored beside the count");

        let batch = lens.batch("t");
        let counting = lens.counting("t");
        lens.keep("t", counting, &shape, 1);
        assert_eq!(lens.kept("t"), None, "the writer was inside a batch");
        batch.stored(adds(1), || {});

        let counting = lens.counting("t");
        lens.keep("t", counting, &shape, 2);
        let mut sent = false;
        lens.batch("t").stored(adds(1), || sent = true);
        assert!(sent, "the batch's projection is handed on as the batch is added");
        assert_eq!(lens.kept("t"), Some(3));
        assert_eq!(lens.kept("u"), None, "another thread's count");

        drop(lens.batch("t"));
        assert_eq!(lens.kept("t"), None, "a failed batch");
    }

    /// A forgotten thread holds nothing: its entry goes at once, or when the batch its writer is inside ends, and a count
    /// begun before it was forgotten is not kept on the entry made after.
    #[test]
    fn a_forgotten_thread_holds_no_entry() {
        let lens = Arc::new(ContextLens::default());
        let shape = LogShape::of_no_log();
        let adds = |added| Growth { restart: None, added };

        let counting = lens.counting("t");
        lens.keep("t", counting, &shape, 1);
        lens.forget("t");
        assert!(!lens.holds("t"), "an idle thread's entry goes at once");

        let batch = lens.batch("t");
        lens.forget("t");
        assert!(lens.holds("t"), "the writer is inside a batch");
        batch.stored(adds(1), || {});
        assert!(!lens.holds("t"), "the entry goes as the batch ends");

        drop(lens.batch("u"));
        lens.forget("u");
        assert!(!lens.holds("u"));

        let before = lens.counting("t");
        lens.forget("t");
        let after = lens.counting("t");
        lens.keep("t", before, &shape, 5);
        assert_eq!(lens.kept("t"), None, "a count begun on the forgotten entry");
        lens.keep("t", after, &shape, 2);
        assert_eq!(lens.kept("t"), Some(2));
    }
}
