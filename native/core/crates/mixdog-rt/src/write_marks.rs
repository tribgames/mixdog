//! [`WriteMarks`]: what a write-behind writer reports to a barrier that must answer "every write accepted before me is on
//! disk" (the replay's `replay/storesSettled`). Each accepted write takes the next number (the accepted count); the writer
//! reports each number written or failed, and the committed count is the highest number up to which every write was
//! written. A barrier takes [`WriteMarks::accepted`] when it arrives and waits for [`WriteMarks::reached`] of that number:
//! writes accepted later neither hold nor hasten it, and a failed write at or below it answers an error naming the store.
//! Numbers may finish out of order (a store whose files are written separately); the committed count waits for the lowest.

use std::collections::BTreeSet;
use std::sync::Mutex;
use std::sync::MutexGuard;

pub struct WriteMarks {
    store: &'static str,
    state: Mutex<Marks>,
    moved: tokio::sync::Notify,
}

#[derive(Default)]
struct Marks {
    accepted: u64,
    /// Accepted and neither written nor failed yet.
    open: BTreeSet<u64>,
    /// The lowest-numbered write that failed, and why.
    failed: Option<(u64, String)>,
}

impl WriteMarks {
    /// `store` names the writer in a barrier's error.
    pub fn new(store: &'static str) -> Self {
        Self { store, state: Mutex::new(Marks::default()), moved: tokio::sync::Notify::new() }
    }

    fn lock(&self) -> MutexGuard<'_, Marks> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Numbers one accepted write.
    pub fn accept(&self) -> u64 {
        let mut marks = self.lock();
        marks.accepted += 1;
        let mark = marks.accepted;
        marks.open.insert(mark);
        mark
    }

    /// The write numbered `mark` is on disk.
    pub fn written(&self, mark: u64) {
        self.finish(mark, None);
    }

    /// The write numbered `mark` was taken back before its writer had it (its queue refused it, and the caller was told):
    /// nothing of it is owed to the disk.
    pub fn withdrawn(&self, mark: u64) {
        self.finish(mark, None);
    }

    /// The write numbered `mark` did not reach the disk.
    pub fn failed(&self, mark: u64, error: impl std::fmt::Display) {
        self.finish(mark, Some(error.to_string()));
    }

    fn finish(&self, mark: u64, error: Option<String>) {
        {
            let mut marks = self.lock();
            marks.open.remove(&mark);
            if let Some(error) = error
                && marks.failed.as_ref().is_none_or(|(at, _)| mark < *at)
            {
                marks.failed = Some((mark, error));
            }
        }
        self.moved.notify_waiters();
    }

    /// How many writes were accepted so far: the number a barrier waits for.
    pub fn accepted(&self) -> u64 {
        self.lock().accepted
    }

    /// The highest number up to which every write was written or failed.
    pub fn committed(&self) -> u64 {
        let marks = self.lock();
        marks.open.first().map_or(marks.accepted, |first| first - 1)
    }

    /// `Some(Ok)` once every write numbered up to `mark` is written, `Some(Err)` naming the store once one of them failed,
    /// `None` while one is still open.
    pub fn check(&self, mark: u64) -> Option<Result<(), String>> {
        let marks = self.lock();
        if let Some((at, error)) = &marks.failed
            && *at <= mark
        {
            return Some(Err(format!("{}: write {at}, accepted before the barrier, failed: {error}", self.store)));
        }
        marks.open.first().is_none_or(|first| *first > mark).then_some(Ok(()))
    }

    /// Resolves as [`Self::check`] once it is `Some`.
    pub async fn reached(&self, mark: u64) -> Result<(), String> {
        loop {
            let notified = self.moved.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(answer) = self.check(mark) {
                return answer;
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::WriteMarks;

    #[test]
    fn a_barrier_answers_at_the_writes_before_it_and_not_later_ones() {
        let marks = WriteMarks::new("store");
        let (first, second) = (marks.accept(), marks.accept());
        let barrier = marks.accepted();
        let later = marks.accept();
        assert_eq!(marks.check(barrier), None, "nothing written");
        // Out of order: the second is written first; the first still holds the barrier.
        marks.written(second);
        assert_eq!((marks.check(barrier), marks.committed()), (None, 0));
        marks.written(first);
        assert_eq!(marks.check(barrier), Some(Ok(())), "the later write is still open");
        assert_eq!(marks.committed(), 2);
        marks.written(later);
        assert_eq!(marks.committed(), 3);
    }

    #[test]
    fn a_failed_write_before_the_barrier_is_its_error_and_a_later_one_is_not() {
        let marks = WriteMarks::new("the store");
        let first = marks.accept();
        let barrier = marks.accepted();
        let later = marks.accept();
        marks.failed(later, "disk full");
        assert_eq!(marks.check(barrier), None, "a later failure neither answers nor fails it");
        marks.failed(first, "denied");
        assert_eq!(marks.check(barrier), Some(Err("the store: write 1, accepted before the barrier, failed: denied".to_owned())));
    }
}
