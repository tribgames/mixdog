//! `promptHistoryList`: the composer's Up-arrow recall, derived exactly as today's session
//! runtime derives it (`src/tui/session/prompt-history.mjs`, `src/tui/prompt-history-store.mjs`):
//!
//! - the session part: the thread's `user` rows over the whole transcript, newest first,
//!   trimmed, deduped by key (whitespace runs collapsed), at most 50 (`recomputePromptHistory`);
//! - merged with the per-cwd persisted history (oldest → newest on disk, read newest first):
//!   session entries first, then persisted ones not already present, at most 50
//!   (`buildMergedPromptHistory`);
//! - a user-submitted prompt is appended to the persisted history of the thread's cwd
//!   (drop the earlier duplicate, push, keep the newest 50: `appendPromptHistory`);
//! - a prompt handed back to the composer (abort or rewind restore) leaves the published
//!   list until the next recompute (`promptHistoryWithout`).
//!
//! The session part is maintained incrementally on every acked `user` row. A clear recomputes
//! it from the store over the remaining lineage and republishes the merge (`replaceItems`); a
//! rewind recomputes it too but publishes only the list without the restored prompt
//! (`replaceItems(.., {preserveSpill})` then `promptHistoryWithout`), as today.
//!
//! The per-cwd files are `mixdog_core_files::prompt_history`'s, which the terminal interface reads too.

use std::time::Duration;

use mixdog_app_protocol::v2::thread::PromptHistoryChange;
pub use mixdog_core_files::prompt_history::Appended;
pub use mixdog_core_files::prompt_history::FLUSH_CAP;
pub use mixdog_core_files::prompt_history::FilePromptHistory;
pub use mixdog_core_files::prompt_history::PROMPT_HISTORY_LIMIT;
pub use mixdog_core_files::prompt_history::PromptHistoryStore;
pub use mixdog_core_files::prompt_history::WRITE_BEHIND_MS;
pub use mixdog_core_files::prompt_history::key;
use mixdog_core_files::prompt_history::trim;
pub use mixdog_core_files::prompt_history::write_retry_delay;

/// What the next step of an [`AppendQueue`] is.
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    Idle,
    /// Append these now, oldest first.
    Flush(Vec<String>),
    /// Wake with `due(epoch)` after `delay`; any later wait replaces this one.
    Wait {
        epoch: u64,
        delay: Duration,
    },
}

/// The appends not yet on disk of one thread (`pendingAppends`, `pendingTimers`, `writeFailures`,
/// `prompt-history-store.mjs:94-98, 161-197, 255-271`). An append arms the write-behind timer at
/// [`WRITE_BEHIND_MS`], replacing whatever wait was armed (a backoff included), and
/// [`FLUSH_CAP`] queued appends flush at once. A flush that did not land puts its appends back ahead
/// of newer ones and arms the timer at [`write_retry_delay`] of the failures in a row, for ever;
/// a landed one resets the count. One flush runs at a time here (Node lets them overlap).
#[derive(Debug, Default)]
pub struct AppendQueue {
    pending: Vec<String>,
    failures: u32,
    in_flight: bool,
    /// The wait whose `due` still counts.
    timer: Option<u64>,
    /// A flush came due while one was running: it goes when that one ends.
    flush_after: bool,
    epoch: u64,
    /// Each append numbered as it is pushed and reported once its flush landed or failed: the replay barrier's positions
    /// ([`super::SessionDirectory::durability_settled`]).
    #[cfg(any(test, feature = "test-support"))]
    marks: Marks,
    /// The numbers of `pending`, in its order.
    #[cfg(any(test, feature = "test-support"))]
    queued: Vec<u64>,
    /// The numbers of the appends the running flush took.
    #[cfg(any(test, feature = "test-support"))]
    flushing: Vec<u64>,
}

/// [`mixdog_rt::WriteMarks`] of the prompt history, shared with whoever reads them without the queue's owner.
#[cfg(any(test, feature = "test-support"))]
pub struct Marks(std::sync::Arc<mixdog_rt::WriteMarks>);

#[cfg(any(test, feature = "test-support"))]
impl Default for Marks {
    fn default() -> Self {
        Self(std::sync::Arc::new(mixdog_rt::WriteMarks::new("the prompt history")))
    }
}

/// The queue's owner ended (the thread's actor stopped) with appends neither landed nor failed: nobody writes them now.
#[cfg(any(test, feature = "test-support"))]
impl Drop for Marks {
    fn drop(&mut self) {
        self.0.abandon("the thread ended before the append was written");
    }
}

#[cfg(any(test, feature = "test-support"))]
impl std::fmt::Debug for Marks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Marks(accepted {}, committed {})", self.0.accepted(), self.0.committed())
    }
}

impl AppendQueue {
    fn begin(&mut self) -> Vec<String> {
        self.in_flight = true;
        self.timer = None;
        self.flush_after = false;
        #[cfg(any(test, feature = "test-support"))]
        {
            self.flushing = std::mem::take(&mut self.queued);
        }
        std::mem::take(&mut self.pending)
    }

    /// The appends' numbers: a barrier takes `accepted()` when it arrives and waits for `check` of it.
    #[cfg(any(test, feature = "test-support"))]
    pub fn marks(&self) -> &mixdog_rt::WriteMarks {
        &self.marks.0
    }

    fn arm(&mut self, delay: Duration) -> Next {
        self.epoch += 1;
        self.timer = Some(self.epoch);
        Next::Wait { epoch: self.epoch, delay }
    }

    /// A prompt to append.
    pub fn push(&mut self, text: String) -> Next {
        self.pending.push(text);
        #[cfg(any(test, feature = "test-support"))]
        self.queued.push(self.marks.0.accept());
        if self.pending.len() >= FLUSH_CAP {
            if self.in_flight {
                self.timer = None;
                self.flush_after = true;
                return Next::Idle;
            }
            return Next::Flush(self.begin());
        }
        self.arm(Duration::from_millis(WRITE_BEHIND_MS))
    }

    /// The flush ended; `unwritten` is what did not land (oldest first).
    pub fn flushed(&mut self, unwritten: Vec<String>) -> Next {
        self.in_flight = false;
        #[cfg(any(test, feature = "test-support"))]
        {
            // The first appends of the flush landed; the rest, `unwritten`, go back ahead of the newer ones.
            let mut flushing = std::mem::take(&mut self.flushing);
            let unlanded = flushing.split_off(flushing.len() - unwritten.len());
            flushing.into_iter().for_each(|mark| self.marks.0.written(mark));
            if let Some(&first) = unlanded.first() {
                self.marks.0.failed(first, "the append was not written");
            }
            self.queued.splice(0..0, unlanded);
        }
        if unwritten.is_empty() {
            self.failures = 0;
            return if self.flush_after && !self.pending.is_empty() { Next::Flush(self.begin()) } else { Next::Idle };
        }
        self.failures += 1;
        let newer = std::mem::take(&mut self.pending);
        self.pending = unwritten;
        self.pending.extend(newer);
        self.flush_after = false;
        self.arm(write_retry_delay(self.failures))
    }

    /// The wait `epoch` ended; `Some(batch)` when it is still the current one and nothing runs.
    pub fn due(&mut self, epoch: u64) -> Option<Vec<String>> {
        if self.timer != Some(epoch) {
            return None;
        }
        self.timer = None;
        if self.in_flight {
            self.flush_after = true;
            return None;
        }
        (!self.pending.is_empty()).then(|| self.begin())
    }
}

/// A newer `user` row: it moves to the front of the session part (newest first).
pub(crate) fn push_session(session: &mut Vec<String>, text: &str) {
    let k = key(text);
    session.retain(|entry| key(entry) != k);
    session.insert(0, trim(text).to_owned());
    session.truncate(PROMPT_HISTORY_LIMIT);
}

/// `buildMergedPromptHistory(session, persisted)`; `persisted` is oldest → newest.
pub(crate) fn merge(session: &[String], persisted: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in session.iter().chain(persisted.iter().rev()) {
        if out.len() >= PROMPT_HISTORY_LIMIT {
            break;
        }
        let text = trim(raw);
        let k = key(text);
        if k.is_empty() || !seen.insert(k) {
            continue;
        }
        out.push(text.to_owned());
    }
    out
}

/// `promptHistoryWithout(list, text)`.
pub(crate) fn without(list: &[String], text: &str) -> Vec<String> {
    let k = key(text);
    list.iter().filter(|entry| key(entry) != k).cloned().collect()
}

/// The client's apply of `PromptHistoryChange::Added`: drop the entry with the same key, put
/// `prompt` in front, keep the first 50.
fn added(list: &[String], prompt: &str) -> Vec<String> {
    let k = key(prompt);
    let mut next = vec![prompt.to_owned()];
    next.extend(list.iter().filter(|entry| key(entry) != k).cloned());
    next.truncate(PROMPT_HISTORY_LIMIT);
    next
}

/// The `thread/promptHistory/updated` value taking `before` to `after`: `added` when the
/// client's apply of it reproduces `after` exactly, else the whole list.
pub(crate) fn change(before: &[String], after: &[String]) -> Option<PromptHistoryChange> {
    if before == after {
        return None;
    }
    Some(match after.first() {
        Some(prompt) if added(before, prompt) == after => PromptHistoryChange::Added { prompt: prompt.clone() },
        _ => PromptHistoryChange::Replaced { prompts: after.to_vec() },
    })
}

/// `recomputePromptHistory(items)` over the prompt texts of the `user` rows, oldest first.
pub(crate) fn recompute(rows: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in rows.iter().rev() {
        if out.len() >= PROMPT_HISTORY_LIMIT {
            break;
        }
        let text = trim(raw);
        let k = key(text);
        if k.is_empty() || !seen.insert(k) {
            continue;
        }
        out.push(text.to_owned());
    }
    out
}

#[cfg(test)]
mod tests {
    use mixdog_rt::DurabilityIo;
    use mixdog_rt::InLane;
    use mixdog_rt::InteractiveIo;

    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|t| (*t).to_owned()).collect()
    }

    #[test]
    fn session_part_is_newest_first_deduped_by_collapsed_key_and_capped() {
        let mut session = Vec::new();
        for text in ["one", "two", " one ", "two\n  more"] {
            push_session(&mut session, text);
        }
        assert_eq!(session, s(&["two\n  more", "one", "two"]));
        for n in 0..60 {
            push_session(&mut session, &format!("p{n}"));
        }
        assert_eq!(session.len(), PROMPT_HISTORY_LIMIT);
        assert_eq!(session[0], "p59");
    }

    #[test]
    fn merge_puts_session_first_then_persisted_newest_first_without_duplicates() {
        let merged = merge(&s(&["b", "a"]), &s(&["x", "a", "y"]));
        assert_eq!(merged, s(&["b", "a", "y", "x"]));
        assert_eq!(without(&merged, " a "), s(&["b", "y", "x"]));
    }

    /// The replay barrier's positions: an append pushed before the barrier holds it until its flush landed, one pushed after
    /// it does not, and an append before it whose flush failed is its error.
    #[test]
    fn the_barrier_waits_for_the_appends_before_it_and_a_failed_one_is_its_error() {
        let mut queue = AppendQueue::default();
        let Next::Wait { epoch, .. } = queue.push("before".into()) else { panic!("the first append waits the window") };
        let mark = queue.marks().accepted();
        assert_eq!(queue.due(epoch), Some(s(&["before"])));
        let Next::Wait { epoch, .. } = queue.push("after".into()) else { panic!("an append during a flush waits the window") };
        assert_eq!(queue.marks().check(mark), None, "the append from before the barrier is still being written");
        assert_eq!(queue.flushed(Vec::new()), Next::Idle);
        assert_eq!(queue.marks().check(mark), Some(Ok(())), "the later append, still queued, does not hold it");
        assert_eq!((queue.marks().committed(), queue.marks().accepted()), (mark, mark + 1));

        let later = queue.marks().accepted();
        assert_eq!(queue.due(epoch), Some(s(&["after"])));
        assert!(matches!(queue.flushed(s(&["after"])), Next::Wait { .. }), "the failed append is retried");
        assert_eq!(
            queue.marks().check(later),
            Some(Err("the prompt history: write 2, accepted before the barrier, failed: the append was not written".to_owned()))
        );
        assert_eq!(queue.marks().check(mark), Some(Ok(())), "a failure after a barrier is not its error");
    }

    #[test]
    fn recompute_scans_newest_first() {
        assert_eq!(recompute(&s(&["a", "b", " a", ""])), s(&["a", "b"]));
    }

    #[test]
    fn updates_are_added_when_the_client_rule_reproduces_the_list() {
        assert_eq!(change(&s(&["a"]), &s(&["a"])), None);
        assert_eq!(change(&s(&["a", "b"]), &s(&["b", "a"])), Some(PromptHistoryChange::Added { prompt: "b".into() }));
        assert_eq!(change(&s(&["a", "b"]), &s(&["a"])), Some(PromptHistoryChange::Replaced { prompts: s(&["a"]) }));
    }

    struct Flaky {
        fail: std::sync::atomic::AtomicU32,
        stamps: std::sync::Mutex<Vec<tokio::time::Instant>>,
        landed: std::sync::Mutex<Vec<String>>,
        /// Woken after every attempted write, landed or not.
        attempted: tokio::sync::Notify,
    }
    impl PromptHistoryStore for Flaky {
        fn load(&self, _: &InLane<InteractiveIo>, _: &str) -> Vec<String> {
            Vec::new()
        }
        fn append(&self, _: &InLane<DurabilityIo>, _: &str, text: &str) -> Appended {
            use std::sync::atomic::Ordering::SeqCst;
            self.stamps.lock().unwrap().push(tokio::time::Instant::now());
            let failing = self.fail.try_update(SeqCst, SeqCst, |n| n.checked_sub(1)).is_ok();
            if !failing {
                self.landed.lock().unwrap().push(text.to_owned());
            }
            self.attempted.notify_waiters();
            Appended { list: s(&[text]), written: !failing }
        }
        fn redact(&self, _: &InLane<DurabilityIo>, _: &str, _: &dyn Fn(&str) -> String) {}
    }

    /// A prompt whose write failed is not lost: the thread flushes it after the window and retries on
    /// Node's backoff. The clock is paused and held, so it moves only by the advances below: each follows the actor's arming of the
    /// timer it brings to its end, and is followed by the write it brings.
    #[tokio::test(start_paused = true)]
    async fn a_prompt_whose_write_failed_is_retried_on_nodes_backoff_until_it_lands() {
        use std::sync::atomic::Ordering::SeqCst;

        use crate::eventually_on;
        use crate::session::SessionDirectory;
        use crate::session::testing::{HeldClock, Rig};
        use crate::session::tests::{start_thread, turn};

        let _held = HeldClock::hold();
        let rig = Rig::new();
        let flaky = std::sync::Arc::new(Flaky { fail: 2.into(), stamps: Default::default(), landed: Default::default(), attempted: Default::default() });
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.prompts = flaky.clone();
        let directory = SessionDirectory::new(std::sync::Arc::new(deps));
        let handle = start_thread(&directory).await;
        let asked = tokio::time::Instant::now();
        turn(&handle, "remember me", "op-1").await;
        for (armed, wait) in [(1, Duration::from_millis(WRITE_BEHIND_MS)), (2, write_retry_delay(1)), (3, write_retry_delay(2))] {
            eventually_on!(&[&handle.cell.stepped], || (handle.cell.prompt_timers.load(SeqCst) == armed).then_some(())).await;
            assert_eq!(flaky.stamps.lock().unwrap().len(), armed as usize - 1, "no write before its timer has ended");
            tokio::time::advance(wait).await;
            eventually_on!(&[&flaky.attempted], || (flaky.stamps.lock().unwrap().len() == armed as usize).then_some(())).await;
        }
        let stamps = flaky.stamps.lock().unwrap().clone();
        assert_eq!(stamps.len(), 3);
        assert_eq!(stamps[0] - asked, Duration::from_millis(WRITE_BEHIND_MS), "the first flush waits the window");
        assert_eq!(stamps[1] - stamps[0], write_retry_delay(1));
        assert_eq!(stamps[2] - stamps[1], write_retry_delay(2));
        assert_eq!(*flaky.landed.lock().unwrap(), s(&["remember me"]));
    }
}

#[cfg(any(test, feature = "test-support"))]
impl AppendQueue {
    /// A queue numbering its appends on `marks`: the thread's [`super::control::ControlCell::prompt_marks`], which the
    /// replay barrier reads as it arrives, without waiting for the actor.
    pub fn numbered_on(marks: std::sync::Arc<mixdog_rt::WriteMarks>) -> Self {
        Self { marks: Marks(marks), ..Self::default() }
    }
}
