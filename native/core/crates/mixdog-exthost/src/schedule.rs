//! Who runs next (RL §11.2): one FIFO per thread, round-robin across threads, a cap on one
//! thread's calls in flight, and thread→worker pins for workers that hold a thread's state.
//! Pure data; the dispatcher owns it and no lock guards it.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::ops::Bound;

use mixdog_protocol::ThreadId;

pub(crate) struct Assignment<C> {
    pub(crate) thread: ThreadId,
    pub(crate) worker: u32,
    pub(crate) id: u32,
    pub(crate) item: C,
}

pub(crate) struct Schedule<C> {
    queues: BTreeMap<ThreadId, VecDeque<(u32, C)>>,
    queued: HashMap<u32, ThreadId>,
    /// The thread served last; the next pick starts after it.
    last: Option<ThreadId>,
    inflight: HashMap<ThreadId, usize>,
    pins: HashMap<ThreadId, u32>,
    per_thread_cap: usize,
}

impl<C> Schedule<C> {
    pub(crate) fn new(per_thread_cap: usize) -> Self {
        Self {
            queues: BTreeMap::new(),
            queued: HashMap::new(),
            last: None,
            inflight: HashMap::new(),
            pins: HashMap::new(),
            per_thread_cap,
        }
    }

    pub(crate) fn enqueue(&mut self, thread: ThreadId, id: u32, item: C) {
        self.queued.insert(id, thread.clone());
        self.queues.entry(thread).or_default().push_back((id, item));
    }

    /// Removes a call that has not been assigned yet.
    pub(crate) fn remove_queued(&mut self, id: u32) -> Option<C> {
        let thread = self.queued.remove(&id)?;
        let queue = self.queues.get_mut(&thread)?;
        let at = queue.iter().position(|(queued, _)| *queued == id)?;
        let (_, item) = queue.remove(at)?;
        if queue.is_empty() {
            self.queues.remove(&thread);
        }
        Some(item)
    }

    fn eligible(&self, thread: &ThreadId, ready: &[u32]) -> Option<u32> {
        if self.inflight.get(thread).copied().unwrap_or(0) >= self.per_thread_cap {
            return None;
        }
        match self.pins.get(thread) {
            Some(worker) => ready.contains(worker).then_some(*worker),
            None => ready.first().copied(),
        }
    }

    /// The next call to start on one of the `ready` (idle) workers, if any. A thread's calls
    /// stay in order: only its oldest queued call is considered.
    pub(crate) fn next(&mut self, ready: &[u32]) -> Option<Assignment<C>> {
        if ready.is_empty() {
            return None;
        }
        let after: Box<dyn Iterator<Item = &ThreadId> + '_> = match &self.last {
            Some(last) => Box::new(
                self.queues
                    .range::<ThreadId, _>((Bound::Excluded(last), Bound::Unbounded))
                    .chain(self.queues.range::<ThreadId, _>(..=last))
                    .map(|(thread, _)| thread),
            ),
            None => Box::new(self.queues.keys()),
        };
        let (thread, worker) = after
            .into_iter()
            .find_map(|thread| self.eligible(thread, ready).map(|w| (thread.clone(), w)))?;
        let queue = self.queues.get_mut(&thread)?;
        let (id, item) = queue.pop_front()?;
        if queue.is_empty() {
            self.queues.remove(&thread);
        }
        self.queued.remove(&id);
        *self.inflight.entry(thread.clone()).or_default() += 1;
        self.last = Some(thread.clone());
        Some(Assignment {
            thread,
            worker,
            id,
            item,
        })
    }

    /// A call of `thread` ended on `worker`. `pin` is the worker's report of whether it still
    /// holds state for the thread; `None` (the worker died) leaves pins to [`Self::worker_gone`].
    pub(crate) fn finished(&mut self, thread: &ThreadId, worker: u32, pin: Option<bool>) {
        if let Some(count) = self.inflight.get_mut(thread) {
            *count -= 1;
            if *count == 0 {
                self.inflight.remove(thread);
            }
        }
        match pin {
            Some(true) => {
                self.pins.insert(thread.clone(), worker);
            }
            Some(false) if self.pins.get(thread) == Some(&worker) => {
                self.pins.remove(thread);
            }
            Some(false) | None => {}
        }
    }

    /// A worker exited: the state it held is gone.
    pub(crate) fn worker_gone(&mut self, worker: u32) {
        self.pins.retain(|_, pinned| *pinned != worker);
    }

    /// How many queued calls could start now if a free worker existed: the calls under their
    /// thread's cap whose thread is not tied to a particular worker.
    pub(crate) fn demand(&self) -> usize {
        self.queues
            .iter()
            .filter(|(thread, _)| !self.pins.contains_key(*thread))
            .map(|(thread, queue)| {
                let room = self
                    .per_thread_cap
                    .saturating_sub(self.inflight.get(thread).copied().unwrap_or(0));
                queue.len().min(room)
            })
            .sum()
    }

    /// Every queued call, removed.
    pub(crate) fn drain(&mut self) -> Vec<C> {
        self.queued.clear();
        std::mem::take(&mut self.queues)
            .into_values()
            .flatten()
            .map(|(_, item)| item)
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn has_queued(&self) -> bool {
        !self.queues.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(name: &str) -> ThreadId {
        ThreadId::from(name)
    }

    fn pick(s: &mut Schedule<&'static str>, ready: &[u32]) -> Option<(String, u32)> {
        s.next(ready).map(|a| (a.item.to_owned(), a.worker))
    }

    #[test]
    fn round_robin_across_threads_fifo_within() {
        let mut s = Schedule::new(8);
        for (thread, id, name) in [
            ("a", 1, "a1"),
            ("a", 2, "a2"),
            ("a", 3, "a3"),
            ("b", 4, "b1"),
            ("c", 5, "c1"),
        ] {
            s.enqueue(t(thread), id, name);
        }
        let order: Vec<_> = std::iter::from_fn(|| pick(&mut s, &[0]).map(|(n, _)| n)).collect();
        assert_eq!(order, ["a1", "b1", "c1", "a2", "a3"]);
    }

    #[test]
    fn a_thread_never_exceeds_its_cap_and_resumes_when_one_ends() {
        let mut s = Schedule::new(1);
        s.enqueue(t("a"), 1, "a1");
        s.enqueue(t("a"), 2, "a2");
        s.enqueue(t("b"), 3, "b1");
        assert_eq!(pick(&mut s, &[0, 1]).unwrap().0, "a1");
        assert_eq!(pick(&mut s, &[1]).unwrap().0, "b1");
        assert_eq!(pick(&mut s, &[1]), None, "a is at its cap");
        s.finished(&t("a"), 0, Some(false));
        assert_eq!(pick(&mut s, &[0]).unwrap().0, "a2");
    }

    #[test]
    fn a_pinned_thread_waits_for_its_worker_and_other_threads_use_the_rest() {
        let mut s = Schedule::new(2);
        s.enqueue(t("a"), 1, "a1");
        assert_eq!(pick(&mut s, &[3]).unwrap(), ("a1".into(), 3));
        s.finished(&t("a"), 3, Some(true));
        s.enqueue(t("a"), 2, "a2");
        s.enqueue(t("b"), 3, "b1");
        assert_eq!(s.demand(), 1, "a's call needs worker 3, not a new one");
        assert_eq!(pick(&mut s, &[5]).unwrap(), ("b1".into(), 5));
        assert_eq!(pick(&mut s, &[5]), None);
        assert_eq!(pick(&mut s, &[3, 5]).unwrap(), ("a2".into(), 3));
    }

    #[test]
    fn a_dead_worker_releases_its_pins() {
        let mut s = Schedule::new(2);
        s.enqueue(t("a"), 1, "a1");
        s.next(&[3]).unwrap();
        s.finished(&t("a"), 3, Some(true));
        s.worker_gone(3);
        s.enqueue(t("a"), 2, "a2");
        assert_eq!(pick(&mut s, &[4]).unwrap(), ("a2".into(), 4));
    }

    #[test]
    fn removing_a_queued_call_leaves_the_rest() {
        let mut s = Schedule::new(2);
        s.enqueue(t("a"), 1, "a1");
        s.enqueue(t("a"), 2, "a2");
        assert_eq!(s.remove_queued(1), Some("a1"));
        assert_eq!(s.remove_queued(1), None);
        assert_eq!(pick(&mut s, &[0]).unwrap().0, "a2");
        assert!(!s.has_queued());
    }
}
