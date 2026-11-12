//! The one async turn gate (hang audit F15/F17): first-come, first-served exclusion that a
//! cancel token can always leave.
//!
//! It replaces `tokio::sync::Mutex` (whose `lock().await` cannot be cancelled and whose guard
//! tends to be held across long awaits). Every entry takes the caller's [`CancellationToken`]:
//!
//! - a waiter whose token fires leaves the queue at once, whoever holds the gate and however
//!   stuck that holder is;
//! - [`Gate::run`] also races the critical section against the same token, so a holder that is
//!   stuck is dropped by the cancel and its turn passes to the next waiter.
//!
//! The queue underneath is [`SerialChain`] (std mutex taken for a few instructions, never across
//! an await). Keep the guarded section short: state belongs in a `std::sync::Mutex` read and
//! written between awaits, and the gate only orders the steps that must not interleave.

use std::future::Future;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::scoped::Scope;
use crate::serial::ChainGuard;
use crate::serial::KeyedChains;
use crate::serial::SerialChain;

/// The caller's token fired before (or while) the gate section ran.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GateCancelled;

impl std::fmt::Display for GateCancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("cancelled while waiting for the gate")
    }
}

impl std::error::Error for GateCancelled {}

/// The turn on a gate, held until dropped.
pub struct GateGuard { _turn: ChainGuard }

/// The one cancel primitive of the dispatchers ([`Scope::run`], no deadline): cancel wins a tie,
/// so a token that already fired never takes a free gate, and the work is dropped on cancel.
pub(crate) async fn until_cancelled<T>(cancel: &CancellationToken, work: impl Future<Output = T>) -> Result<T, GateCancelled> {
    Scope::new().cancel(cancel).run(work).await.done().ok_or(GateCancelled)
}

/// One gate.
#[derive(Default)]
pub struct Gate {
    chain: Arc<SerialChain>,
}

impl Gate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Waits for the turn behind everything that arrived earlier; `Err` once `cancel` fires.
    pub async fn enter(&self, cancel: &CancellationToken) -> Result<GateGuard, GateCancelled> {
        until_cancelled(cancel, self.chain.acquire()).await.map(|_turn| GateGuard { _turn })
    }

    /// Runs `work` holding the turn. `cancel` ends the wait for the turn and, once the turn is
    /// held, drops `work` itself, so a stuck section cannot outlive its caller's cancel.
    pub async fn run<T>(&self, cancel: &CancellationToken, work: impl Future<Output = T>) -> Result<T, GateCancelled> {
        until_cancelled(cancel, self.chain.run(work)).await
    }

    /// Whether the turn is held or anyone waits for it.
    pub fn is_busy(&self) -> bool {
        self.chain.is_busy()
    }
}

/// One gate per string key, created on first use and dropped when nothing holds or waits on it.
#[derive(Default)]
pub struct KeyedGate {
    chains: Arc<KeyedChains>,
}

impl KeyedGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// As [`Gate::enter`] for `key`; different keys never wait on each other.
    pub async fn enter(&self, key: &str, cancel: &CancellationToken) -> Result<GateGuard, GateCancelled> {
        until_cancelled(cancel, self.chains.acquire(key)).await.map(|_turn| GateGuard { _turn })
    }

    /// As [`Gate::run`] for `key`.
    pub async fn run<T>(&self, key: &str, cancel: &CancellationToken, work: impl Future<Output = T>) -> Result<T, GateCancelled> {
        until_cancelled(cancel, self.chains.run(key, work)).await
    }

    /// Keys held or waited on.
    pub fn busy_keys(&self) -> usize {
        self.chains.busy_keys()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::Poll;

    /// Polls once: `None` while pending.
    async fn poll_once<F: Future + Unpin>(future: &mut F) -> Option<F::Output> {
        std::future::poll_fn(|cx| match std::pin::Pin::new(&mut *future).poll(cx) {
            Poll::Ready(out) => Poll::Ready(Some(out)),
            Poll::Pending => Poll::Ready(None),
        })
        .await
    }

    #[tokio::test]
    async fn a_waiter_leaves_when_its_token_fires_though_the_holder_is_stuck() {
        let gate = Gate::new();
        let held = gate.enter(&CancellationToken::new()).await.unwrap();
        let cancel = CancellationToken::new();
        let mut waiter = Box::pin(gate.enter(&cancel));
        assert!(poll_once(&mut waiter).await.is_none(), "queued behind the holder");
        cancel.cancel();
        assert!(matches!(poll_once(&mut waiter).await, Some(Err(GateCancelled))));
        drop(waiter);
        // The cancelled waiter left no place behind: the holder's release frees the gate.
        drop(held);
        assert!(!gate.is_busy());
    }

    #[tokio::test]
    async fn a_stuck_section_is_dropped_by_the_cancel_and_the_next_caller_enters() {
        let gate = Gate::new();
        let cancel = CancellationToken::new();
        let mut stuck = Box::pin(gate.run(&cancel, std::future::pending::<()>()));
        assert!(poll_once(&mut stuck).await.is_none());
        assert!(gate.is_busy());

        let other = CancellationToken::new();
        let mut next = Box::pin(gate.enter(&other));
        assert!(poll_once(&mut next).await.is_none(), "waits while the section is stuck");

        cancel.cancel();
        assert!(matches!(poll_once(&mut stuck).await, Some(Err(GateCancelled))));
        drop(stuck);
        // The stuck section's turn went to the waiter.
        assert!(matches!(poll_once(&mut next).await, Some(Ok(_))));
    }

    #[tokio::test]
    async fn a_fired_token_never_takes_a_free_gate() {
        let gate = Gate::new();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(matches!(gate.enter(&cancel).await, Err(GateCancelled)));
        assert!(matches!(gate.run(&cancel, async {}).await, Err(GateCancelled)));
        assert!(!gate.is_busy());
    }

    #[tokio::test]
    async fn waiters_enter_in_arrival_order() {
        let gate = Arc::new(Gate::new());
        let first = gate.enter(&CancellationToken::new()).await.unwrap();
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut tasks = Vec::new();
        for n in 0..3 {
            let (gate, order) = (gate.clone(), order.clone());
            tasks.push(tokio::spawn(async move {
                let _turn = gate.enter(&CancellationToken::new()).await.unwrap();
                order.lock().unwrap().push(n);
            }));
            tokio::task::yield_now().await;
        }
        drop(first);
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(*order.lock().unwrap(), vec![0, 1, 2]);
    }

    #[tokio::test]
    async fn a_keyed_waiter_is_cancellable_and_other_keys_do_not_wait() {
        let gates = KeyedGate::new();
        let held = gates.enter("a", &CancellationToken::new()).await.unwrap();
        let _other = gates.enter("b", &CancellationToken::new()).await.unwrap();
        let cancel = CancellationToken::new();
        let mut waiter = Box::pin(gates.enter("a", &cancel));
        assert!(poll_once(&mut waiter).await.is_none());
        cancel.cancel();
        assert!(matches!(poll_once(&mut waiter).await, Some(Err(GateCancelled))));
        drop(waiter);
        drop(held);
        assert_eq!(gates.busy_keys(), 1, "only `b` remains");
    }
}
