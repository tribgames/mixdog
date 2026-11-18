//! The local-inference request queue. It owns the complete request, not just server startup:
//! requests run one at a time in arrival order, and the idle unload takes the same lane, so new
//! work can never race an unload in progress.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::change::ChangeSignal;
use crate::media::store::now_ms;

pub const DEFAULT_LOCAL_IDLE_TTL_SECONDS: u64 = 3600;
const MAX_IDLE_TTL_SECONDS: u64 = 86_400;
const DEFAULT_MAX_QUEUE: usize = 128;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum QueueError {
    #[error("[local-provider] local inference is stopping")]
    Stopping,
    #[error("[local-provider] request queue is full")]
    Full,
    #[error("aborted")]
    Aborted,
    #[error("idleTtlSeconds must be an integer from 0 (disabled) to 86400.")]
    InvalidTtl,
}

pub fn local_idle_ttl_seconds(value: i64) -> Result<u64, QueueError> {
    u64::try_from(value).ok().filter(|v| *v <= MAX_IDLE_TTL_SECONDS).ok_or(QueueError::InvalidTtl)
}

/// Unloads the model server.
#[async_trait]
pub trait Unload: Send + Sync {
    async fn unload(&self) -> Result<(), String>;
}

struct Request {
    id: u64,
    cancel: CancellationToken,
    started: bool,
}

#[derive(Default)]
struct State {
    requests: Vec<Request>,
    next_id: u64,
    active: usize,
    ttl: u64,
    idle: Option<JoinHandle<()>>,
    idle_deadline: Option<i64>,
    last_unload_error: Option<String>,
    stopping: bool,
}

struct Inner {
    // One permit: the semaphore is never closed, so an acquire only waits its turn.
    serial: tokio::sync::Semaphore,
    state: Mutex<State>,
    unloader: Arc<dyn Unload>,
    max_queue: usize,
    signal: ChangeSignal,
}

#[derive(Clone)]
pub struct RequestQueue(Arc<Inner>);

struct RequestGuard<'a> {
    queue: &'a RequestQueue,
    id: u64,
}

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        let mut state = self.queue.0.state.lock().unwrap();
        if let Some(index) = state.requests.iter().position(|r| r.id == self.id) {
            let request = state.requests.remove(index);
            state.active -= if request.started { 1 } else { 0 };
        }
        self.queue.schedule_idle(&mut state);
        self.queue.0.signal.notify();
    }
}

struct StopGuard(RequestQueue);

impl Drop for StopGuard {
    fn drop(&mut self) {
        let mut state = self.0.0.state.lock().unwrap();
        state.stopping = false;
        self.0.0.signal.notify();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[derive(Default)]
    struct Counter(AtomicUsize);

    #[async_trait]
    impl Unload for Counter {
        async fn unload(&self) -> Result<(), String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn queue(ttl: u64, max: Option<usize>) -> (RequestQueue, Arc<Counter>) {
        let counter = Arc::new(Counter::default());
        (RequestQueue::new(counter.clone(), ttl, max), counter)
    }

    #[tokio::test]
    async fn dropping_run_and_stop_callers_leaves_no_request_and_finishes_unloading() {
        #[derive(Default)]
        struct GatedUnload {
            entered: tokio::sync::Notify,
            release: tokio::sync::Notify,
        }
        #[async_trait]
        impl Unload for GatedUnload {
            async fn unload(&self) -> Result<(), String> {
                self.entered.notify_one();
                self.release.notified().await;
                Ok(())
            }
        }
        let unload = Arc::new(GatedUnload::default());
        let q = RequestQueue::new(unload.clone(), 0, None);
        let mut active = Box::pin(q.run(None, |_| std::future::pending::<()>()));
        let mut waiting = Box::pin(q.run(None, |_| async {}));
        tokio::select! { biased; _ = &mut active => panic!("active request returned"), _ = std::future::ready(()) => {} }
        tokio::select! { biased; _ = &mut waiting => panic!("waiting request returned"), _ = std::future::ready(()) => {} }
        assert_eq!(q.status()["activeRequests"], 1);
        assert_eq!(q.status()["queuedRequests"], 1);
        drop(waiting);
        drop(active);
        assert_eq!(q.status()["activeRequests"], 0);
        assert_eq!(q.status()["queuedRequests"], 0);

        let mut stop = Box::pin(q.stop());
        tokio::select! { biased; _ = &mut stop => panic!("unload returned"), _ = unload.entered.notified() => {} }
        drop(stop);
        assert_eq!(q.run(None, |_| async {}).await, Err(QueueError::Stopping));
        let mut changed = q.0.signal.subscribe();
        unload.release.notify_one();
        changed.changed().await.unwrap();
        assert_eq!(q.run(None, |_| async { 1 }).await, Ok(1));
    }

    #[test]
    fn ttl_is_an_integer_from_zero_to_a_day() {
        assert_eq!(local_idle_ttl_seconds(0), Ok(0));
        assert_eq!(local_idle_ttl_seconds(86_400), Ok(86_400));
        assert_eq!(local_idle_ttl_seconds(86_401), Err(QueueError::InvalidTtl));
        assert_eq!(local_idle_ttl_seconds(-1), Err(QueueError::InvalidTtl));
    }

    #[tokio::test(start_paused = true)]
    async fn a_waiting_request_aborts_early_and_the_queue_has_a_ceiling() {
        let (q, _) = queue(0, Some(1));
        let release = CancellationToken::new();
        let running = {
            let (q, release) = (q.clone(), release.clone());
            tokio::spawn(async move { q.run(None, |_| async move { release.cancelled().await }).await })
        };
        tokio::task::yield_now().await;
        let cancel = CancellationToken::new();
        let waiting = {
            let (q, cancel) = (q.clone(), cancel.clone());
            tokio::spawn(async move { q.run(Some(cancel), |_| async {}).await })
        };
        tokio::task::yield_now().await;
        assert_eq!(q.status()["queuedRequests"], 1);
        assert_eq!(q.run(None, |_| async {}).await, Err(QueueError::Full));
        cancel.cancel();
        assert_eq!(waiting.await.unwrap(), Err(QueueError::Aborted));
        release.cancel();
        running.await.unwrap().unwrap();
        assert_eq!(q.status()["queuedRequests"], 0);
    }

    #[tokio::test(start_paused = true)]
    async fn stop_interrupts_running_work_unloads_and_reopens_the_queue() {
        let (q, counter) = queue(0, None);
        let running = {
            let q = q.clone();
            tokio::spawn(async move { q.run(None, |token| async move { token.cancelled().await; "interrupted" }).await })
        };
        tokio::task::yield_now().await;
        q.stop().await;
        assert_eq!(running.await.unwrap(), Ok("interrupted"));
        assert_eq!(counter.0.load(Ordering::SeqCst), 1);
        assert_eq!(q.run(None, |_| async { 1 }).await, Ok(1));
    }


    #[tokio::test(start_paused = true)]
    async fn requests_run_one_at_a_time_in_arrival_order() {
        let (q, _) = queue(0, None);
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut handles = Vec::new();
        for n in 0..3 {
            let (q, order) = (q.clone(), order.clone());
            handles.push(tokio::spawn(async move {
                q.run(None, |_| async move {
                    order.lock().unwrap().push(format!("start{n}"));
                    mixdog_rt::time::sleep(Duration::from_millis(10)).await;
                    order.lock().unwrap().push(format!("end{n}"));
                })
                .await
            }));
            tokio::task::yield_now().await;
        }
        for h in handles {
            h.await.unwrap().unwrap();
        }
        assert_eq!(*order.lock().unwrap(), ["start0", "end0", "start1", "end1", "start2", "end2"]);
    }
    #[tokio::test(start_paused = true)]
    async fn the_idle_ttl_unloads_once_after_the_last_request() {
        let (q, counter) = queue(60, None);
        q.run(None, |_| async {}).await.unwrap();
        assert!(q.status()["idleDeadline"].is_i64());
        mixdog_rt::time::sleep(Duration::from_secs(59)).await;
        assert_eq!(counter.0.load(Ordering::SeqCst), 0);
        mixdog_rt::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(counter.0.load(Ordering::SeqCst), 1);
        assert!(q.status()["idleDeadline"].is_null());
        // A new request cancels a pending unload.
        q.run(None, |_| async {}).await.unwrap();
        mixdog_rt::time::sleep(Duration::from_secs(30)).await;
        q.run(None, |_| async {}).await.unwrap();
        mixdog_rt::time::sleep(Duration::from_secs(40)).await;
        assert_eq!(counter.0.load(Ordering::SeqCst), 1);
    }
}


impl RequestQueue {
    pub fn new(unloader: Arc<dyn Unload>, idle_ttl_seconds: u64, max_queue: Option<usize>) -> Self {
        Self::with_signal(unloader, idle_ttl_seconds, max_queue, ChangeSignal::default())
    }

    /// A queue that ticks `signal` whenever its `status()` may have changed.
    pub fn with_signal(unloader: Arc<dyn Unload>, idle_ttl_seconds: u64, max_queue: Option<usize>, signal: ChangeSignal) -> Self {
        Self(Arc::new(Inner {
            signal,
            serial: tokio::sync::Semaphore::new(1),
            state: Mutex::new(State { ttl: idle_ttl_seconds, ..State::default() }),
            unloader,
            max_queue: max_queue.unwrap_or(DEFAULT_MAX_QUEUE),
        }))
    }

    fn clear_idle(state: &mut State) {
        if let Some(handle) = state.idle.take() {
            handle.abort();
        }
        state.idle_deadline = None;
    }

    fn schedule_idle(&self, state: &mut State) {
        Self::clear_idle(state);
        if !state.requests.is_empty() || state.stopping || state.ttl == 0 {
            return;
        }
        let ttl = Duration::from_secs(state.ttl);
        state.idle_deadline = Some(now_ms() + ttl.as_millis() as i64);
        let this = self.clone();
        state.idle = Some(tokio::spawn(async move {
            mixdog_rt::time::sleep(ttl).await;
            {
                let mut state = this.0.state.lock().unwrap();
                state.idle = None;
                state.idle_deadline = None;
                this.0.signal.notify();
                if !state.requests.is_empty() {
                    return;
                }
            }
            let _lane = this.0.serial.acquire().await;
            let outcome = this.0.unloader.unload().await;
            this.0.state.lock().unwrap().last_unload_error = outcome.err();
            this.0.signal.notify();
        }));
    }

    /// Runs `operation` in its turn. `cancel` aborts a request still waiting (and is handed to
    /// the operation once it runs).
    pub async fn run<T, F, Fut>(&self, cancel: Option<CancellationToken>, operation: F) -> Result<T, QueueError>
    where
        F: FnOnce(CancellationToken) -> Fut,
        Fut: Future<Output = T>,
    {
        let token = cancel.unwrap_or_default().child_token();
        if token.is_cancelled() {
            return Err(QueueError::Aborted);
        }
        let id = {
            let mut state = self.0.state.lock().unwrap();
            if state.stopping {
                return Err(QueueError::Stopping);
            }
            if state.requests.len() > self.0.max_queue {
                return Err(QueueError::Full);
            }
            Self::clear_idle(&mut state);
            state.next_id += 1;
            let id = state.next_id;
            state.requests.push(Request { id, cancel: token.clone(), started: false });
            id
        };
        let request = RequestGuard { queue: self, id };
        let leaving = token.clone().drop_guard();
        self.0.signal.notify();
        let lane = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(QueueError::Aborted),
            lane = self.0.serial.acquire() => lane,
        };
        if token.is_cancelled() {
            return Err(QueueError::Aborted);
        }
        {
            let mut state = self.0.state.lock().unwrap();
            state.active += 1;
            if let Some(r) = state.requests.iter_mut().find(|r| r.id == id) {
                r.started = true;
            }
        }
        self.0.signal.notify();
        let out = operation(token).await;
        leaving.disarm();
        drop(request);
        drop(lane);
        Ok(out)
    }

    /// Interrupts loading/inference now and unloads; does not wait behind the work it stops.
    pub async fn stop(&self) {
        {
            let mut state = self.0.state.lock().unwrap();
            if state.stopping {
                return;
            }
            state.stopping = true;
            Self::clear_idle(&mut state);
            state.requests.iter().for_each(|r| r.cancel.cancel());
        }
        self.0.signal.notify();
        let this = self.clone();
        let stopping = StopGuard(this.clone());
        // A caller can drop its wait, but admitting new requests before unload finishes races the old child.
        let done = tokio::spawn(async move {
            let outcome = this.0.unloader.unload().await;
            let _lane = this.0.serial.acquire().await;
            if let Err(message) = outcome {
                this.0.state.lock().unwrap().last_unload_error = Some(message);
            }
            drop(stopping);
        }).await;
        if let Err(error) = done {
            self.0.state.lock().unwrap().last_unload_error = Some(error.to_string());
            self.0.signal.notify();
        }
    }

    pub fn configure(&self, seconds: u64) {
        let mut state = self.0.state.lock().unwrap();
        if state.ttl == seconds {
            return;
        }
        state.ttl = seconds;
        if state.requests.is_empty() {
            self.schedule_idle(&mut state);
        }
        self.0.signal.notify();
    }

    pub fn status(&self) -> Value {
        let state = self.0.state.lock().unwrap();
        json!({
            "activeRequests": state.active,
            "queuedRequests": state.requests.len().saturating_sub(state.active),
            "idleTtlSeconds": state.ttl,
            "idleDeadline": state.idle_deadline,
            "lastUnloadError": state.last_unload_error,
        })
    }
}
