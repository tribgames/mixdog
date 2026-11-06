//! A first-come, first-served async turnstile: Node's promise chain (`prev.then(task)`) as a queue
//! of one-shot hand-offs. The holder owns the turn until its guard drops, then the oldest waiter
//! is handed it directly, so order is arrival order, never barging. State changes take a
//! `std::sync::Mutex` for a few instructions and never across an await.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use tokio::sync::oneshot;

#[derive(Default)]
struct Queue {
    held: bool,
    next_id: u64,
    waiters: VecDeque<(u64, oneshot::Sender<()>)>,
}

#[derive(Default)]
pub(super) struct Chain {
    queue: Mutex<Queue>,
}

/// The turn, held until dropped. Dropping a guard that is still waiting (its future was
/// cancelled) leaves the queue, or passes on a hand-off that had already reached it.
pub(super) struct ChainGuard {
    chain: Arc<Chain>,
    owned: bool,
    waiting: Option<(u64, oneshot::Receiver<()>)>,
}

impl Chain {
    fn queue(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn release(queue: &mut Queue) {
        while let Some((_, next)) = queue.waiters.pop_front() {
            if next.send(()).is_ok() {
                return;
            }
        }
        queue.held = false;
    }

    pub(super) async fn acquire(self: &Arc<Self>) -> ChainGuard {
        let mut guard = {
            let mut queue = self.queue();
            if !queue.held && queue.waiters.is_empty() {
                queue.held = true;
                return ChainGuard { chain: self.clone(), owned: true, waiting: None };
            }
            let (tx, rx) = oneshot::channel();
            let id = queue.next_id;
            queue.next_id += 1;
            queue.waiters.push_back((id, tx));
            ChainGuard { chain: self.clone(), owned: false, waiting: Some((id, rx)) }
        };
        if let Some((_, rx)) = guard.waiting.as_mut() {
            // The sender lives in the queue until it hands the turn over; it is never dropped unsent.
            let _ = rx.await;
        }
        guard.owned = true;
        guard.waiting = None;
        guard
    }
}

impl Drop for ChainGuard {
    fn drop(&mut self) {
        let mut queue = self.chain.queue();
        if self.owned {
            Chain::release(&mut queue);
        } else if let Some((id, mut rx)) = self.waiting.take() {
            if rx.try_recv().is_ok() {
                Chain::release(&mut queue);
            } else {
                queue.waiters.retain(|(waiting, _)| *waiting != id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn waiters_get_the_turn_in_arrival_order_and_a_cancelled_one_is_skipped() {
        let chain = Arc::new(Chain::default());
        let first = chain.acquire().await;
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut tasks = Vec::new();
        for n in 0..3 {
            let (chain, order) = (chain.clone(), order.clone());
            tasks.push(tokio::spawn(async move {
                let _turn = chain.acquire().await;
                order.lock().unwrap().push(n);
            }));
            tokio::task::yield_now().await;
        }
        tasks[1].abort();
        tokio::task::yield_now().await;
        assert!(order.lock().unwrap().is_empty(), "nobody runs while the first holds it");
        drop(first);
        let _ = tasks.remove(0).await;
        let _ = tasks.remove(1).await;
        assert_eq!(*order.lock().unwrap(), vec![0, 2]);
        assert!(!chain.queue().held);
    }
}