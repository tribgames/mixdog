//! The length of each thread's model context, kept in memory.
//!
//! A status pass asks the message count of every running worker, and each handoff asks it again. Counting it scans the
//! thread's context rows in the index on an I/O lane. A thread's context grows only through the thread's own log, so
//! once it is counted it is followed here: the thread's writer adds what each batch adds, taken from the projection the
//! index is written from, and a reader takes the number without the index.
//!
//! The count and what is added to it are of one position in the thread's batches. The writer is inside a batch from
//! before it touches the log ([`ContextLens::batch`]) until the batch's projection is with the index writer, and the
//! batch is added here in that same step ([`Batch::stored`]). A count from the index is kept only when the writer was
//! outside a batch at the count's end and ended none since its start: the index, waited for after that start, then
//! held the rows of exactly the batches stored by then, and each later batch is added once. A thread's creation is a
//! batch, so a count of a fork begins after the rows it takes from its bases were stored.
//!
//! A kept count stands while the shape of the thread's history does ([`LogShape::stands`]): a rewind, a rewrite, a
//! repair or a delete drops it, and the next ask counts again. It is the log's count: an index that lost a batch of
//! the thread holds fewer rows, and the store answers for such a thread from the index, never from here.

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
    /// The batches of the thread's writer that have ended.
    batches: u64,
    /// The thread's writer is inside a batch.
    writing: bool,
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

/// By thread. An entry is never removed: a count in progress compares the thread's batches with those it began at.
#[derive(Default)]
pub(super) struct ContextLens(Mutex<HashMap<String, Thread>>);

/// A count of a thread's context being taken: where the thread's batches stood when it began.
pub(super) struct Counting {
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
        if let Some(state) = self.lens.threads().get_mut(&self.thread) {
            state.ended();
            state.kept = None;
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
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The length of `thread`'s context as it is kept now.
    pub(super) fn kept(&self, thread: &str) -> Option<usize> {
        self.threads().get_mut(thread)?.standing()
    }

    /// Begins a count of `thread`'s context. Taken before the wait for the index: every batch stored before this is in
    /// the index after that wait.
    pub(super) fn counting(&self, thread: &str) -> Counting {
        let mut threads = self.threads();
        let state = threads.entry(thread.to_owned()).or_default();
        Counting { batches: state.batches, kept: state.standing() }
    }

    /// Keeps `len`, counted from the index over `shape` since `counting`. Not when the thread's writer is inside a batch
    /// or ended one meanwhile: the log the shape was read from and the index the rows were counted in may then lie on
    /// either side of that batch.
    pub(super) fn keep(&self, thread: &str, counting: Counting, shape: &Arc<LogShape>, len: usize) {
        let mut threads = self.threads();
        let Some(state) = threads.get_mut(thread) else { return };
        if !state.writing && state.batches == counting.batches && shape.stands() {
            state.kept = Some((shape.clone(), len));
        }
    }

    /// `thread`'s writer begins a batch, before it touches the thread's log.
    pub(super) fn batch(self: &Arc<Self>, thread: &str) -> Batch {
        self.threads().entry(thread.to_owned()).or_default().writing = true;
        Batch { lens: self.clone(), thread: thread.to_owned(), stored: false }
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
}
