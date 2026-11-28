//! An owner-fair turn gate: up to `limit` holders at a time, and each free turn goes round the owners that wait instead of to the
//! oldest waiter.
//!
//! Each owner has a queue of its own, first come first served. While a turn is free, the owners with a waiting entry that may
//! take it take it by smooth weighted round-robin at weight 1: every such owner's credit grows by one, the owner with most credit
//! (the first of those at a tie, in the order the owners first queued) is served and pays the number of such owners. Two owners
//! that queue two entries each, `A0 A1 B2 B3`, are served `A0 B2 A1 B3`. An owner's credit lasts while it holds a turn or waits,
//! and starts again at zero after.
//!
//! With several turns, a waiting owner that holds no turn is served before one that already holds one, and an owner is not handed
//! a turn that would leave it holding every turn while another owner waits. An arrival takes a free turn at once only when nobody
//! waits.
//!
//! Cancelling (or dropping) an `enter` that still waits removes its place; a turn already handed to a cancelled waiter passes on
//! to the next. A guard gives its turn back when dropped.

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
    /// The turns this owner holds.
    active: usize,
    queue: VecDeque<(u64, oneshot::Sender<()>)>,
}

impl Group {
    fn idle(&self) -> bool {
        self.active == 0 && self.queue.is_empty()
    }
}

struct State {
    /// The turns there are (at least 1).
    limit: usize,
    /// The turns held; above `limit` only after the limit was lowered under its holders.
    held: usize,
    next_id: u64,
    /// In the order the owners first queued or took a turn.
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

    /// `None`: a turn is the caller's now. `Some`: the caller queued and waits on the hand-off.
    fn enter(&mut self, owner: &str) -> Option<Handoff> {
        let id = self.next_id;
        self.next_id += 1;
        let (tx, mut rx) = oneshot::channel();
        self.group(owner).queue.push_back((id, tx));
        // A free turn means nobody waited: the caller is the one owner ready, and takes it at no net credit.
        self.dispatch();
        if rx.try_recv().is_ok() { None } else { Some((id, rx)) }
    }

    /// The group whose entry is served next: smooth weighted round-robin over the waiting owners that may take a turn,
    /// those holding none first.
    fn pick(&mut self) -> Option<usize> {
        let waiting_owners = self.groups.iter().filter(|g| !g.queue.is_empty()).count();
        // While another owner waits, no owner is handed its last free turn (with one turn, every owner may take it).
        let cap = if waiting_owners > 1 { self.limit.saturating_sub(1).max(1) } else { self.limit };
        let mut ready: Vec<usize> = (0..self.groups.len()).filter(|&i| !self.groups[i].queue.is_empty() && self.groups[i].active < cap).collect();
        // An owner holding no turn is served before one that already holds one (with one turn, nobody holds one here).
        if ready.iter().any(|&i| self.groups[i].active == 0) {
            ready.retain(|&i| self.groups[i].active == 0);
        }
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

    /// Hands every free turn to the next live waiter that may take it, until none is free or none may.
    fn dispatch(&mut self) {
        while self.held < self.limit {
            let Some(at) = self.pick() else { break };
            // `pick` serves only an owner with a waiting entry. A sender whose receiver is gone was not handed the turn.
            if let Some((_, next)) = self.groups[at].queue.pop_front()
                && next.send(()).is_ok()
            {
                self.groups[at].active += 1;
                self.held += 1;
            }
        }
        self.drop_idle();
    }

    /// A holder of `owner` is done: its turn goes to the next live waiter, or is free.
    fn release(&mut self, owner: &str) {
        self.group(owner).active = self.group(owner).active.saturating_sub(1);
        self.held = self.held.saturating_sub(1);
        self.dispatch();
    }

    /// A waiter gave up: it leaves its queue, or returns a turn already handed to it.
    fn abandon(&mut self, owner: &str, id: u64, mut rx: oneshot::Receiver<()>) {
        if rx.try_recv().is_ok() {
            self.release(owner);
        } else {
            self.group(owner).queue.retain(|(waiting, _)| *waiting != id);
            self.dispatch();
        }
    }
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|e| e.into_inner())
}

/// A turn on an [`OwnerGate`], held until dropped.
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
pub struct OwnerGate {
    state: Arc<Mutex<State>>,
}

impl Default for OwnerGate {
    fn default() -> Self {
        Self::with_limit(1)
    }
}

impl OwnerGate {
    /// A gate of one turn.
    pub fn new() -> Self {
        Self::default()
    }

    /// A gate of `limit` turns (at least 1).
    pub fn with_limit(limit: usize) -> Self {
        let state = State { limit: limit.max(1), held: 0, next_id: 0, groups: Vec::new() };
        Self { state: Arc::new(Mutex::new(state)) }
    }

    /// The turns there are.
    pub fn limit(&self) -> usize {
        lock(&self.state).limit
    }

    /// Sets the turns there are (at least 1): a raised limit hands its new turns to the waiters at once; under a lowered
    /// one the holders keep their turns, and no turn is handed out until fewer than the limit are held.
    pub fn set_limit(&self, limit: usize) {
        let mut state = lock(&self.state);
        state.limit = limit.max(1);
        state.dispatch();
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

    /// Waits for a turn as `owner`, served by the rotation over the waiting owners; `Err` once `cancel` fires.
    pub async fn enter(&self, owner: &str, cancel: &CancellationToken) -> Result<OwnerGuard, GateCancelled> {
        until_cancelled(cancel, self.acquire(owner)).await
    }

    /// Whether a turn is held or anyone waits for one.
    pub fn is_busy(&self) -> bool {
        let state = lock(&self.state);
        state.held > 0 || state.waiting()
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

    #[tokio::test]
    async fn owners_hold_turns_at_once_up_to_the_limit() {
        let gate = OwnerGate::with_limit(3);
        let never = CancellationToken::new();
        let a = gate.enter("A", &never).await.unwrap();
        let b = gate.enter("B", &never).await.unwrap();
        let c = gate.enter("C", &never).await.unwrap();
        assert!(![&a, &b, &c].iter().any(|turn| turn.queued()), "three owners hold the three turns at once");
        let mut d = Box::pin(gate.enter("D", &never));
        assert!(poll_once(&mut d).await.is_none(), "every turn is held");
        drop(b);
        let d = poll_once(&mut d).await.expect("the freed turn is handed over").unwrap();
        assert!(d.queued());
        drop((a, c, d));
        assert!(!gate.is_busy());
    }

    #[tokio::test]
    async fn an_owner_is_not_handed_its_last_free_turn_while_another_owner_waits() {
        let gate = OwnerGate::with_limit(2);
        let never = CancellationToken::new();
        // Nobody else waits: one owner may take every turn.
        let x1 = gate.enter("X", &never).await.unwrap();
        let x2 = gate.enter("X", &never).await.unwrap();
        let mut a0 = Box::pin(gate.enter("A", &never));
        let mut a1 = Box::pin(gate.enter("A", &never));
        let mut b2 = Box::pin(gate.enter("B", &never));
        for waiter in [&mut a0, &mut a1, &mut b2] {
            assert!(poll_once(waiter).await.is_none());
        }
        drop(x1);
        let a0 = poll_once(&mut a0).await.expect("A is first in the rotation").unwrap();
        assert!(poll_once(&mut a1).await.is_none());
        assert!(poll_once(&mut b2).await.is_none());
        // A's next entry would leave A every turn while B waits: the turn is B's.
        drop(x2);
        let b2 = poll_once(&mut b2).await.expect("B is served before A holds every turn").unwrap();
        assert!(poll_once(&mut a1).await.is_none());
        drop(a0);
        let a1 = poll_once(&mut a1).await.expect("nobody else waits now").unwrap();
        drop((a1, b2));
        assert!(!gate.is_busy());
    }

    #[tokio::test]
    async fn an_owner_holding_no_turn_is_served_before_one_that_holds_one() {
        let gate = OwnerGate::with_limit(3);
        let never = CancellationToken::new();
        let a = gate.enter("A", &never).await.unwrap();
        let x1 = gate.enter("X", &never).await.unwrap();
        let x2 = gate.enter("X", &never).await.unwrap();
        let mut a_again = Box::pin(gate.enter("A", &never));
        let mut b = Box::pin(gate.enter("B", &never));
        assert!(poll_once(&mut a_again).await.is_none());
        assert!(poll_once(&mut b).await.is_none());
        drop(x1);
        let b = poll_once(&mut b).await.expect("B holds nothing and A holds a turn").unwrap();
        assert!(poll_once(&mut a_again).await.is_none());
        drop(x2);
        let a_again = poll_once(&mut a_again).await.expect("the next free turn is A's").unwrap();
        drop((a, a_again, b));
        assert!(!gate.is_busy());
    }

    #[tokio::test]
    async fn a_waiter_cancelled_or_dropped_by_its_deadline_leaks_no_turn_among_several_holders() {
        let gate = OwnerGate::with_limit(2);
        let never = CancellationToken::new();
        let h1 = gate.enter("H1", &never).await.unwrap();
        let h2 = gate.enter("H2", &never).await.unwrap();
        let cancel_a = CancellationToken::new();
        let mut a = Box::pin(gate.enter("A", &cancel_a));
        let mut late = Box::pin(gate.enter("L", &never));
        let mut b = Box::pin(gate.enter("B", &never));
        let mut c = Box::pin(gate.enter("C", &never));
        for waiter in [&mut a, &mut late, &mut b, &mut c] {
            assert!(poll_once(waiter).await.is_none());
        }
        cancel_a.cancel();
        assert!(matches!(poll_once(&mut a).await, Some(Err(GateCancelled))));
        drop(a);
        // A deadline drops the waiting `enter` itself: its place goes with it.
        drop(late);
        drop(h1);
        // The turn reached B, which is dropped before it polls again: it passes on to C, not lost.
        drop(b);
        let c = poll_once(&mut c).await.expect("the turn B never took is C's").unwrap();
        drop(h2);
        let free = gate.enter("D", &never).await.unwrap();
        assert!(!free.queued(), "the second turn is free");
        drop((c, free));
        assert!(!gate.is_busy());
    }

    #[tokio::test]
    async fn a_raised_limit_hands_its_turns_to_the_waiters() {
        let gate = OwnerGate::new();
        let never = CancellationToken::new();
        let held = gate.enter("A", &never).await.unwrap();
        let mut b = Box::pin(gate.enter("B", &never));
        assert!(poll_once(&mut b).await.is_none());
        gate.set_limit(2);
        assert!(matches!(poll_once(&mut b).await, Some(Ok(_))));
        drop(held);
    }

    /// Many owners, cancels among them, on worker threads: never more holders than turns, every entry admitted or
    /// cancelled exactly once, and the gate free at the end.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn under_contention_no_turn_is_leaked_or_handed_twice() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::atomic::Ordering::SeqCst;
        let gate = Arc::new(OwnerGate::with_limit(3));
        let (inside, most, admitted, cancelled) =
            (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let mut tasks = Vec::new();
        for n in 0..48usize {
            let (gate, inside, most, admitted, cancelled) = (gate.clone(), inside.clone(), most.clone(), admitted.clone(), cancelled.clone());
            tasks.push(tokio::spawn(async move {
                let cancel = CancellationToken::new();
                if n % 5 == 0 {
                    let fire = cancel.clone();
                    tokio::spawn(async move {
                        tokio::task::yield_now().await;
                        fire.cancel();
                    });
                }
                match gate.enter(&format!("owner-{}", n % 4), &cancel).await {
                    Ok(_turn) => {
                        let now = inside.fetch_add(1, SeqCst) + 1;
                        most.fetch_max(now, SeqCst);
                        tokio::task::yield_now().await;
                        inside.fetch_sub(1, SeqCst);
                        admitted.fetch_add(1, SeqCst);
                    }
                    Err(GateCancelled) => {
                        cancelled.fetch_add(1, SeqCst);
                    }
                }
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert!(most.load(SeqCst) <= 3, "{} holders at once", most.load(SeqCst));
        assert_eq!(admitted.load(SeqCst) + cancelled.load(SeqCst), 48);
        assert!(!gate.is_busy());
        let never = CancellationToken::new();
        let mut turns = Vec::new();
        for owner in ["free-0", "free-1", "free-2"] {
            turns.push(gate.enter(owner, &never).await.unwrap());
        }
        assert!(turns.iter().all(|turn| !turn.queued()), "all three turns are free again");
    }
}
