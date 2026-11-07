//! First-come, first-served serialization across awaits: Node's promise chain
//! (`prev = prev.then(task)`), as one primitive.
//!
//! [`SerialChain`] is one chain; [`KeyedChains`] is a chain per string key (a session, a file, an
//! owner), created on first use and dropped as soon as nothing holds or waits on it. Both hand
//! out a [`ChainGuard`]: the holder owns the turn until the guard drops, and the oldest waiter is
//! then handed it directly, so order is arrival order and a late arrival never barges past a
//! queue.
//!
//! - **No lock across an await.** The queue state sits behind a `std::sync::Mutex` that is taken
//!   for a few instructions at a time (enter, release, abandon) and never while a task runs or a
//!   waiter waits. The wait itself is a one-shot hand-off, not a lock or a semaphore permit.
//! - **Cancellation.** Dropping an `acquire` future that is still waiting removes its place from
//!   the queue. If the turn had already been handed to it, the drop passes the turn on to the next
//!   waiter instead of stranding the chain.
//! - **Panics.** A task that panics while holding the guard releases it as the guard drops.
//!
//! Use [`run`](SerialChain::run) when the whole critical section is one future, and `acquire`
//! when the guard must outlive a call or be dropped early.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use tokio::sync::oneshot;

type Handoff = (u64, oneshot::Receiver<()>);

#[derive(Default)]
struct Queue {
    held: bool,
    next_id: u64,
    waiters: VecDeque<(u64, oneshot::Sender<()>)>,
}

impl Queue {
    fn idle(&self) -> bool {
        !self.held && self.waiters.is_empty()
    }

    /// `None`: the turn is the caller's now. `Some`: the caller queued and waits on the hand-off.
    fn enter(&mut self) -> Option<Handoff> {
        if self.idle() {
            self.held = true;
            return None;
        }
        let (tx, rx) = oneshot::channel();
        let id = self.next_id;
        self.next_id += 1;
        self.waiters.push_back((id, tx));
        Some((id, rx))
    }

    /// Hands the turn to the oldest live waiter, or frees the chain.
    fn release(&mut self) {
        while let Some((_, next)) = self.waiters.pop_front() {
            if next.send(()).is_ok() {
                return;
            }
        }
        self.held = false;
    }

    /// A waiter gave up: it leaves the queue, or returns a turn already handed to it.
    fn abandon(&mut self, id: u64, mut rx: oneshot::Receiver<()>) {
        if rx.try_recv().is_ok() {
            self.release();
        } else {
            self.waiters.retain(|(waiting, _)| *waiting != id);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Where a guard's queue lives; private so only the two chains below exist.
trait Slots: Send + Sync {
    fn enter(&self, key: &str) -> Option<Handoff>;
    fn release(&self, key: &str);
    fn abandon(&self, key: &str, id: u64, rx: oneshot::Receiver<()>);
}

/// The turn on a chain, held until dropped.
pub struct ChainGuard {
    slots: Arc<dyn Slots>,
    key: String,
    owned: bool,
    waiting: Option<Handoff>,
}

impl ChainGuard {
    async fn acquire(slots: Arc<dyn Slots>, key: &str) -> ChainGuard {
        let waiting = slots.enter(key);
        // The guard exists before the wait, so cancelling the wait runs its drop.
        let mut guard = ChainGuard { slots, key: key.to_owned(), owned: waiting.is_none(), waiting };
        if let Some((_, rx)) = guard.waiting.as_mut() {
            // The sender stays in the queue until it hands the turn over; it is never dropped unsent.
            let _ = rx.await;
            guard.waiting = None;
            guard.owned = true;
        }
        guard
    }
}

impl Drop for ChainGuard {
    fn drop(&mut self) {
        if self.owned {
            self.slots.release(&self.key);
        } else if let Some((id, rx)) = self.waiting.take() {
            self.slots.abandon(&self.key, id, rx);
        }
    }
}

/// One serialization chain.
#[derive(Default)]
pub struct SerialChain {
    queue: Mutex<Queue>,
}

impl Slots for SerialChain {
    fn enter(&self, _: &str) -> Option<Handoff> {
        lock(&self.queue).enter()
    }

    fn release(&self, _: &str) {
        lock(&self.queue).release();
    }

    fn abandon(&self, _: &str, id: u64, rx: oneshot::Receiver<()>) {
        lock(&self.queue).abandon(id, rx);
    }
}

impl SerialChain {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// Waits for the turn behind everything that arrived earlier.
    pub async fn acquire(self: &Arc<Self>) -> ChainGuard {
        ChainGuard::acquire(self.clone(), "").await
    }

    /// Runs `task` holding the turn.
    pub async fn run<T>(self: &Arc<Self>, task: impl Future<Output = T>) -> T {
        let _turn = self.acquire().await;
        task.await
    }

    /// Whether the turn is held or anyone waits for it.
    pub fn is_busy(&self) -> bool {
        !lock(&self.queue).idle()
    }
}

/// A chain per key. A key exists only while it is held or waited on, so the map never grows
/// with the keys seen.
#[derive(Default)]
pub struct KeyedChains {
    queues: Mutex<HashMap<String, Queue>>,
}

impl Slots for KeyedChains {
    fn enter(&self, key: &str) -> Option<Handoff> {
        lock(&self.queues).entry(key.to_owned()).or_default().enter()
    }

    fn release(&self, key: &str) {
        let mut queues = lock(&self.queues);
        if let Some(queue) = queues.get_mut(key) {
            queue.release();
            if queue.idle() {
                queues.remove(key);
            }
        }
    }

    fn abandon(&self, key: &str, id: u64, rx: oneshot::Receiver<()>) {
        let mut queues = lock(&self.queues);
        if let Some(queue) = queues.get_mut(key) {
            queue.abandon(id, rx);
            if queue.idle() {
                queues.remove(key);
            }
        }
    }
}

impl KeyedChains {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// Waits for the turn on `key`, behind everything that arrived earlier on that key. Different
    /// keys never wait on each other.
    pub async fn acquire(self: &Arc<Self>, key: &str) -> ChainGuard {
        ChainGuard::acquire(self.clone(), key).await
    }

    /// Runs `task` holding the turn on `key`.
    pub async fn run<T>(self: &Arc<Self>, key: &str, task: impl Future<Output = T>) -> T {
        let _turn = self.acquire(key).await;
        task.await
    }

    /// Whether `key` is held or waited on.
    pub fn is_busy(&self, key: &str) -> bool {
        lock(&self.queues).contains_key(key)
    }

    /// Keys held or waited on.
    pub fn busy_keys(&self) -> usize {
        lock(&self.queues).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    async fn arrive_in_order(chain: &Arc<SerialChain>, count: usize, order: &Arc<Mutex<Vec<usize>>>) -> Vec<tokio::task::JoinHandle<()>> {
        let mut tasks = Vec::new();
        for n in 0..count {
            let (chain, order) = (chain.clone(), order.clone());
            tasks.push(tokio::spawn(async move {
                let _turn = chain.acquire().await;
                lock(&order).push(n);
            }));
            tokio::task::yield_now().await;
        }
        tasks
    }

    #[tokio::test]
    async fn waiters_get_the_turn_in_arrival_order_and_a_cancelled_one_is_skipped() {
        let chain = SerialChain::new();
        let first = chain.acquire().await;
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut tasks = arrive_in_order(&chain, 4, &order).await;
        tasks[1].abort();
        tokio::task::yield_now().await;
        assert!(lock(&order).is_empty(), "nobody runs while the first holds it");
        drop(first);
        for task in tasks.drain(..) {
            let _ = task.await;
        }
        assert_eq!(*lock(&order), vec![0, 2, 3]);
        assert!(!chain.is_busy());
    }

    #[tokio::test(start_paused = true)]
    async fn a_waiter_cancelled_after_the_hand_off_passes_the_turn_on() {
        let chain = SerialChain::new();
        let first = chain.acquire().await;
        let mut second = Box::pin(chain.acquire());
        assert!(futures_poll_once(&mut second).await.is_none());
        let third = tokio::spawn({
            let chain = chain.clone();
            async move { drop(chain.acquire().await) }
        });
        tokio::task::yield_now().await;
        // The turn reaches the second waiter, which is dropped before it ever polls again.
        drop(first);
        drop(second);
        tokio::time::timeout(Duration::from_secs(5), third).await.unwrap().unwrap();
        assert!(!chain.is_busy());
    }

    #[tokio::test]
    async fn keys_are_independent_and_a_settled_key_leaves_the_map() {
        let chains = KeyedChains::new();
        let a = chains.acquire("a").await;
        let b = chains.acquire("b").await;
        assert_eq!(chains.busy_keys(), 2);
        let queued = tokio::spawn({
            let chains = chains.clone();
            async move { chains.run("a", async {}).await }
        });
        tokio::task::yield_now().await;
        assert!(!queued.is_finished(), "same key waits");
        drop(b);
        assert!(!chains.is_busy("b"));
        drop(a);
        queued.await.unwrap();
        assert_eq!(chains.busy_keys(), 0);
    }

    #[tokio::test]
    async fn a_cancelled_last_waiter_leaves_no_key_behind() {
        let chains = KeyedChains::new();
        let held = chains.acquire("k").await;
        let waiter = tokio::spawn({
            let chains = chains.clone();
            async move { chains.run("k", async {}).await }
        });
        tokio::task::yield_now().await;
        waiter.abort();
        let _ = waiter.await;
        drop(held);
        assert_eq!(chains.busy_keys(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn state_is_readable_while_a_task_holding_the_turn_awaits() {
        let chain = SerialChain::new();
        let running = tokio::spawn({
            let chain = chain.clone();
            async move { chain.run(tokio::time::sleep(Duration::from_millis(200))).await }
        });
        tokio::task::yield_now().await;
        // `is_busy` takes the state mutex; it would deadlock here if a task held it across its await.
        assert!(chain.is_busy());
        running.await.unwrap();
        assert!(!chain.is_busy());
    }

    /// Polls a future once; `None` when it is still pending.
    async fn futures_poll_once<F: Future + Unpin>(future: &mut F) -> Option<F::Output> {
        std::future::poll_fn(|cx| match std::pin::Pin::new(&mut *future).poll(cx) {
            std::task::Poll::Ready(out) => std::task::Poll::Ready(Some(out)),
            std::task::Poll::Pending => std::task::Poll::Ready(None),
        })
        .await
    }
}
