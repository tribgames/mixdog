//! Per-server call admission with owner fairness (T §4 target 3). A lone owner may use all the
//! capacity; when owners contend the queue rotates between them, and an owner always keeps
//! `min_owner_queue` places even in a full queue so a late interactive session is not shut out
//! by one session's fan-out. The gate belongs to one server, so one server's backlog never
//! delays another's calls; its lock guards counters only (no await, no I/O).

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AdmissionError {
    #[error("admission queue is full ({queued} waiting); retry after running work completes")]
    QueueFull { queued: usize },
    #[error("admission wait exceeded {0:?}; retry after running work completes")]
    WaitTimeout(Duration),
    #[error("cancelled while waiting for admission")]
    Cancelled,
    #[error("{0}")]
    Closed(String),
}

struct Waiter {
    ticket: u64,
    grant: oneshot::Sender<()>,
}

#[derive(Default)]
struct State {
    active: usize,
    queued: usize,
    next_ticket: u64,
    /// Owners with waiting calls, in service order.
    rotation: VecDeque<String>,
    queues: HashMap<String, VecDeque<Waiter>>,
    closed: Option<String>,
}

pub struct AdmissionGate {
    active_max: Option<usize>,
    queue_max: usize,
    min_owner_queue: usize,
    state: Mutex<State>,
}

/// A held slot; dropping it admits the next waiter.
#[must_use]
pub struct Permit {
    gate: Arc<AdmissionGate>,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.gate.release();
    }
}

impl AdmissionGate {
    pub fn new(active_max: Option<usize>, queue_max: usize, min_owner_queue: usize) -> Arc<Self> {
        Arc::new(Self {
            active_max,
            queue_max,
            min_owner_queue,
            state: Mutex::new(State::default()),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn active(&self) -> usize {
        self.lock().active
    }

    pub fn queued(&self) -> usize {
        self.lock().queued
    }

    fn has_capacity(&self, state: &State) -> bool {
        self.active_max.is_none_or(|max| state.active < max)
    }

    /// Fails every waiter and every later `acquire` with `reason`.
    pub fn close(&self, reason: &str) {
        let mut state = self.lock();
        state.closed = Some(reason.to_owned());
        state.queued = 0;
        state.rotation.clear();
        state.queues.clear();
    }

    fn release(&self) {
        let mut state = self.lock();
        state.active = state.active.saturating_sub(1);
        self.dispatch(&mut state);
    }

    fn dispatch(&self, state: &mut State) {
        while state.queued > 0 && self.has_capacity(state) {
            let Some(owner) = state.rotation.pop_front() else { return };
            let Some(queue) = state.queues.get_mut(&owner) else { continue };
            let Some(waiter) = queue.pop_front() else {
                state.queues.remove(&owner);
                continue;
            };
            if queue.is_empty() {
                state.queues.remove(&owner);
            } else {
                state.rotation.push_back(owner);
            }
            state.queued -= 1;
            state.active += 1;
            if waiter.grant.send(()).is_err() {
                // The waiter went away before the grant; its slot is free again.
                state.active -= 1;
            }
        }
    }

    pub async fn acquire(
        self: &Arc<Self>,
        owner: &str,
        cancel: &CancellationToken,
        wait: Duration,
    ) -> Result<Permit, AdmissionError> {
        let (grant, mut granted) = oneshot::channel();
        let ticket = {
            let mut state = self.lock();
            if let Some(reason) = &state.closed {
                return Err(AdmissionError::Closed(reason.clone()));
            }
            if state.queued == 0 && self.has_capacity(&state) {
                state.active += 1;
                return Ok(Permit { gate: Arc::clone(self) });
            }
            let owner_queued = state.queues.get(owner).map_or(0, VecDeque::len);
            if state.queued >= self.queue_max && owner_queued >= self.min_owner_queue {
                return Err(AdmissionError::QueueFull { queued: state.queued });
            }
            let ticket = state.next_ticket;
            state.next_ticket += 1;
            if owner_queued == 0 {
                state.rotation.push_back(owner.to_owned());
            }
            state
                .queues
                .entry(owner.to_owned())
                .or_default()
                .push_back(Waiter { ticket, grant });
            state.queued += 1;
            ticket
        };
        // Covers every exit, including the caller dropping this future.
        let mut waiting = Waiting { gate: self, owner, ticket, granted: &mut granted, done: false };
        let outcome = tokio::select! {
            result = &mut *waiting.granted => Some(result),
            () = cancel.cancelled() => None,
            () = mixdog_rt::time::sleep(wait) => {
                return Err(AdmissionError::WaitTimeout(wait));
            }
        };
        match outcome {
            Some(Ok(())) => {
                waiting.done = true;
                Ok(Permit { gate: Arc::clone(self) })
            }
            Some(Err(_)) => {
                waiting.done = true;
                let reason = self.lock().closed.clone().unwrap_or_else(|| "admission gate closed".to_owned());
                Err(AdmissionError::Closed(reason))
            }
            None => Err(AdmissionError::Cancelled),
        }
    }
}

struct Waiting<'a> {
    gate: &'a Arc<AdmissionGate>,
    owner: &'a str,
    ticket: u64,
    granted: &'a mut oneshot::Receiver<()>,
    done: bool,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        // Closing first makes a concurrent grant fail (the dispatcher undoes it); a grant that
        // already landed is returned here.
        self.granted.close();
        let was_granted = self.granted.try_recv().is_ok();
        let mut state = self.gate.lock();
        if let Some(queue) = state.queues.get_mut(self.owner)
            && let Some(position) = queue.iter().position(|w| w.ticket == self.ticket)
        {
            queue.remove(position);
            state.queued -= 1;
            if state.queues.get(self.owner).is_some_and(VecDeque::is_empty) {
                state.queues.remove(self.owner);
                state.rotation.retain(|o| o != self.owner);
            }
        }
        if was_granted {
            state.active = state.active.saturating_sub(1);
            self.gate.dispatch(&mut state);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unbounded_gate_admits_everything() {
        let gate = AdmissionGate::new(None, 4, 1);
        let cancel = CancellationToken::new();
        let mut permits = Vec::new();
        for _ in 0..50 {
            permits.push(gate.acquire("a", &cancel, Duration::from_secs(1)).await.unwrap());
        }
        assert_eq!(gate.active(), 50);
    }

    #[tokio::test]
    async fn waiters_rotate_between_owners() {
        let gate = AdmissionGate::new(Some(1), 16, 2);
        let cancel = CancellationToken::new();
        let first = gate.acquire("a", &cancel, Duration::from_secs(5)).await.unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut tasks = Vec::new();
        for owner in ["a", "a", "b"] {
            let (g, cancel, order) = (Arc::clone(&gate), cancel.clone(), Arc::clone(&order));
            tasks.push(tokio::spawn(async move {
                let permit = g.acquire(owner, &cancel, Duration::from_secs(5)).await.unwrap();
                order.lock().unwrap().push(owner);
                drop(permit);
            }));
            while gate.queued() < tasks.len() {
                tokio::task::yield_now().await;
            }
        }
        drop(first);
        for task in tasks {
            task.await.unwrap();
        }
        // "b" is served second even though both "a" calls queued before it.
        assert_eq!(*order.lock().unwrap(), vec!["a", "b", "a"]);
    }

    #[tokio::test]
    async fn full_queue_rejects_but_keeps_room_for_a_new_owner() {
        let gate = AdmissionGate::new(Some(1), 1, 1);
        let cancel = CancellationToken::new();
        let _held = gate.acquire("a", &cancel, Duration::from_secs(5)).await.unwrap();
        let g = Arc::clone(&gate);
        let c = cancel.clone();
        let waiting = tokio::spawn(async move { g.acquire("a", &c, Duration::from_secs(5)).await.map(|_| ()) });
        while gate.queued() < 1 {
            tokio::task::yield_now().await;
        }
        let rejected = gate.acquire("a", &cancel, Duration::from_secs(5)).await;
        assert!(matches!(rejected, Err(AdmissionError::QueueFull { .. })));
        let g = Arc::clone(&gate);
        let c = cancel.clone();
        let other = tokio::spawn(async move { g.acquire("b", &c, Duration::from_millis(30)).await.map(|_| ()) });
        assert_eq!(other.await.unwrap(), Err(AdmissionError::WaitTimeout(Duration::from_millis(30))));
        waiting.abort();
    }

    #[tokio::test]
    async fn cancelled_waiter_leaves_the_queue_and_frees_nothing_twice() {
        let gate = AdmissionGate::new(Some(1), 4, 1);
        let held = gate.acquire("a", &CancellationToken::new(), Duration::from_secs(5)).await.unwrap();
        let cancel = CancellationToken::new();
        let g = Arc::clone(&gate);
        let c = cancel.clone();
        let waiting = tokio::spawn(async move { g.acquire("b", &c, Duration::from_secs(5)).await.map(|_| ()) });
        while gate.queued() < 1 {
            tokio::task::yield_now().await;
        }
        cancel.cancel();
        assert_eq!(waiting.await.unwrap(), Err(AdmissionError::Cancelled));
        assert_eq!(gate.queued(), 0);
        drop(held);
        assert_eq!(gate.active(), 0);
    }
}
