//! An owner-fair turn gate: one holder at a time, and the next turn goes round the owners that wait instead of to the
//! oldest waiter (Node's `createOwnerFairGate` over `createFairCallScheduler`, `owner-groups.mjs` `pickGroup`).
//!
//! Each owner has a queue of its own, first come first served. When the turn is free, the owners with a waiting
//! entry take it by smooth weighted round-robin at weight 1: every waiting owner's credit grows by one, the owner with
//! most credit (the first of those at a tie, in the order the owners first queued) is served and pays the number of
//! waiting owners. Two owners that queue two entries each, `A0 A1 B2 B3`, are served `A0 B2 A1 B3`. An owner's credit
//! lasts while it holds the turn or waits, and starts again at zero after.
//!
//! It is [`Gate`](crate::gate::Gate) for callers that must not let one owner's backlog use up another's wait; the plain
//! gate keeps arrival order for its own users. Cancelling an `enter` that still waits removes its place; a turn
//! already handed to a cancelled waiter passes on to the next.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::gate::GateCancelled;
use crate::gate::until_cancelled;

type Handoff = (u64, oneshot::Receiver<()>);

struct Group {
    owner: String,
    current: i64,
    /// 1 while this owner holds the turn.
    active: u32,
    queue: VecDeque<(u64, oneshot::Sender<()>)>,
}

impl Group {
    fn idle(&self) -> bool {
        self.active == 0 && self.queue.is_empty()
    }
}

#[derive(Default)]
struct State {
    held: bool,
    next_id: u64,
    /// In the order the owners first queued or took the turn.
    groups: Vec<Group>,
}

impl State {
    fn group(&mut self, owner: &str) -> &mut Group {
        let at = match self.groups.iter().position(|g| g.owner == owner) {
            Some(at) => at,
            None => {
                self.groups.push(Group { owner: owner.to_owned(), current: 0, active: 0, queue: VecDeque::new() });
                self.groups.len() - 1
            }
        };
        &mut self.groups[at]
    }

    fn drop_idle(&mut self) {
        self.groups.retain(|g| !g.idle());
    }

    fn waiting(&self) -> bool {
        self.groups.iter().any(|g| !g.queue.is_empty())
    }

    /// `None`: the turn is the caller's now. `Some`: the caller queued and waits on the hand-off.
    fn enter(&mut self, owner: &str) -> Option<Handoff> {
        if !self.held && !self.waiting() {
            self.held = true;
            self.group(owner).active += 1;
            return None;
        }
        let id = self.next_id;
        self.next_id += 1;
        let (tx, rx) = oneshot::channel();
        self.group(owner).queue.push_back((id, tx));
        Some((id, rx))
    }

    /// The group whose entry is served next: smooth weighted round-robin over the waiting owners.
    fn pick(&mut self) -> Option<usize> {
        let ready: Vec<usize> = (0..self.groups.len()).filter(|&i| !self.groups[i].queue.is_empty()).collect();
        let total = i64::try_from(ready.len()).ok()?;
        let mut chosen: Option<usize> = None;
        for &i in &ready {
            self.groups[i].current += 1;
            if chosen.is_none_or(|c| self.groups[i].current > self.groups[c].current) {
                chosen = Some(i);
            }
        }
        let chosen = chosen?;
        self.groups[chosen].current -= total;
        Some(chosen)
    }

    /// The holder `owner` is done: the turn goes to the next live waiter, or the gate is free.
    fn release(&mut self, owner: &str) {
        self.group(owner).active = self.group(owner).active.saturating_sub(1);
        self.held = false;
        while let Some(at) = self.pick() {
            let Some((_, next)) = self.groups[at].queue.pop_front() else { continue };
            if next.send(()).is_ok() {
                self.groups[at].active += 1;
                self.held = true;
                break;
            }
        }
        self.drop_idle();
    }

    /// A waiter gave up: it leaves its queue, or returns a turn already handed to it.
    fn abandon(&mut self, owner: &str, id: u64, mut rx: oneshot::Receiver<()>) {
        if rx.try_recv().is_ok() {
            self.release(owner);
        } else {
            self.group(owner).queue.retain(|(waiting, _)| *waiting != id);
            self.drop_idle();
        }
    }
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|e| e.into_inner())
}

/// The turn on an [`OwnerGate`], held until dropped.
pub struct OwnerGuard {
    state: Arc<Mutex<State>>,
    owner: String,
    owned: bool,
    waiting: Option<Handoff>,
    queued: bool,
}

impl OwnerGuard {
    /// Whether the caller had to queue behind others for this turn.
    pub fn queued(&self) -> bool {
        self.queued
    }
}

impl Drop for OwnerGuard {
    fn drop(&mut self) {
        if self.owned {
            lock(&self.state).release(&self.owner);
        } else if let Some((id, rx)) = self.waiting.take() {
            lock(&self.state).abandon(&self.owner, id, rx);
        }
    }
}

/// One owner-fair gate.
#[derive(Default)]
pub struct OwnerGate {
    state: Arc<Mutex<State>>,
}

impl OwnerGate {
    pub fn new() -> Self {
        Self::default()
    }

    async fn acquire(&self, owner: &str) -> OwnerGuard {
        let waiting = lock(&self.state).enter(owner);
        // The guard exists before the wait, so cancelling the wait runs its drop.
        let mut guard = OwnerGuard { state: self.state.clone(), owner: owner.to_owned(), owned: waiting.is_none(), queued: waiting.is_some(), waiting };
        if let Some((_, rx)) = guard.waiting.as_mut() {
            // The sender stays in the queue until it hands the turn over; it is never dropped unsent.
            let _ = rx.await;
            guard.waiting = None;
            guard.owned = true;
        }
        guard
    }

    /// Waits for the turn as `owner`, served by the rotation over the waiting owners; `Err` once `cancel` fires.
    pub async fn enter(&self, owner: &str, cancel: &CancellationToken) -> Result<OwnerGuard, GateCancelled> {
        until_cancelled(cancel, self.acquire(owner)).await
    }

    /// Whether the turn is held or anyone waits for it.
    pub fn is_busy(&self) -> bool {
        let state = lock(&self.state);
        state.held || state.waiting()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::Poll;

    async fn poll_once<F: std::future::Future + Unpin>(future: &mut F) -> Option<F::Output> {
        std::future::poll_fn(|cx| match std::pin::Pin::new(&mut *future).poll(cx) {
            Poll::Ready(out) => Poll::Ready(Some(out)),
            Poll::Pending => Poll::Ready(None),
        })
        .await
    }

    /// Queues `entries` (owner, name) behind a held gate, in order, then lets the holder go: the names in the order served.
    async fn served(entries: &[(&str, &str)]) -> Vec<String> {
        let gate = Arc::new(OwnerGate::new());
        let holder = gate.enter("holder", &CancellationToken::new()).await.unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut tasks = Vec::new();
        for (owner, name) in entries {
            let (gate, order, owner, name) = (gate.clone(), order.clone(), owner.to_string(), name.to_string());
            tasks.push(tokio::spawn(async move {
                let _turn = gate.enter(&owner, &CancellationToken::new()).await.unwrap();
                order.lock().unwrap().push(name);
            }));
            tokio::task::yield_now().await;
        }
        drop(holder);
        for task in tasks {
            task.await.unwrap();
        }
        assert!(!gate.is_busy());
        let order = order.lock().unwrap().clone();
        order
    }

    #[tokio::test]
    async fn two_owners_with_two_entries_each_are_served_by_turns() {
        // Node's probe of `createOwnerFairGate`: owners A and B queueing two each answer A0, B2, A1, B3.
        assert_eq!(served(&[("A", "A0"), ("A", "A1"), ("B", "B2"), ("B", "B3")]).await, ["A0", "B2", "A1", "B3"]);
    }

    #[tokio::test]
    async fn a_lone_owner_is_served_in_arrival_order_and_a_late_owner_joins_the_rotation() {
        assert_eq!(served(&[("A", "A0"), ("A", "A1"), ("A", "A2")]).await, ["A0", "A1", "A2"]);
        assert_eq!(served(&[("A", "A0"), ("A", "A1"), ("A", "A2"), ("B", "B3")]).await, ["A0", "B3", "A1", "A2"]);
    }

    #[tokio::test]
    async fn a_cancelled_waiter_loses_its_place_and_a_handed_turn_passes_on() {
        let gate = OwnerGate::new();
        let holder = gate.enter("holder", &CancellationToken::new()).await.unwrap();
        let (cancel_a, cancel_b) = (CancellationToken::new(), CancellationToken::new());
        let mut a = Box::pin(gate.enter("A", &cancel_a));
        let mut b = Box::pin(gate.enter("B", &cancel_b));
        assert!(poll_once(&mut a).await.is_none());
        assert!(poll_once(&mut b).await.is_none());
        cancel_a.cancel();
        assert!(matches!(poll_once(&mut a).await, Some(Err(GateCancelled))));
        drop(a);
        // The turn reaches B, which is dropped before it polls again: the gate is free, not stranded.
        drop(holder);
        drop(b);
        assert!(!gate.is_busy());
        assert!(gate.enter("C", &CancellationToken::new()).await.is_ok());
    }

    #[tokio::test]
    async fn a_fired_token_never_takes_a_free_gate() {
        let gate = OwnerGate::new();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(matches!(gate.enter("A", &cancel).await, Err(GateCancelled)));
        assert!(!gate.is_busy());
    }
}
