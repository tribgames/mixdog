//! A session's live memory feed: at most one ingest runs and at most one waits behind it, so a
//! stalled memory service holds two conversations per session, never one per settled turn. A
//! conversation that arrives while one waits replaces it: it is the later read of the same
//! session, and memory's ingest keys each message by its own identity.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::ids::ThreadId;
use serde_json::Value;

use super::seams::CloseIngest;

#[derive(Default)]
struct Slot {
    running: bool,
    waiting: Option<(String, Vec<Value>)>,
}

#[derive(Default)]
pub(crate) struct MemoryFeed(Mutex<Slot>);

impl MemoryFeed {
    /// Feeds `messages` (read when the turn's end was durable) once the ingest before it is done.
    pub(crate) fn offer(self: &Arc<Self>, ingest: Arc<dyn CloseIngest>, thread: ThreadId, cwd: String, messages: Vec<Value>) {
        {
            let mut slot = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if slot.running {
                slot.waiting = Some((cwd, messages));
                return;
            }
            slot.running = true;
        }
        let feed = self.clone();
        tokio::spawn(async move {
            let mut next = Some((cwd, messages));
            while let Some((cwd, messages)) = next {
                ingest.ingest(&thread, &cwd, messages).await;
                let mut slot = feed.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                next = slot.waiting.take();
                slot.running = next.is_some();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Records each ingest as it starts, then holds it until a permit is released.
    struct Gate {
        started: Mutex<Vec<Vec<Value>>>,
        entered: tokio::sync::mpsc::UnboundedSender<()>,
        release: Arc<tokio::sync::Semaphore>,
    }

    impl CloseIngest for Gate {
        fn ingest(&self, _: &ThreadId, _: &str, messages: Vec<Value>) -> futures::future::BoxFuture<'static, ()> {
            self.started.lock().unwrap().push(messages);
            let _ = self.entered.send(());
            let release = self.release.clone();
            Box::pin(async move { release.acquire().await.expect("open").forget() })
        }
    }

    /// While memory is stalled, five settlements leave one ingest running and only the latest
    /// conversation waiting; the ones in between are never held or fed.
    #[tokio::test]
    async fn a_stalled_memory_holds_one_running_and_one_waiting_feed() {
        let (entered, mut ingests) = tokio::sync::mpsc::unbounded_channel();
        let gate = Arc::new(Gate { started: Mutex::default(), entered, release: Arc::new(tokio::sync::Semaphore::new(0)) });
        let feed = Arc::new(MemoryFeed::default());
        let conversation = |n: u64| vec![json!({ "role": "user", "content": format!("turn {n}") })];
        let offer = |n: u64| feed.offer(gate.clone(), ThreadId::from("sess_a"), "/ws".into(), conversation(n));
        offer(1);
        ingests.recv().await.expect("the first ingest starts");
        for n in 2..=5 {
            offer(n);
        }
        assert_eq!(*gate.started.lock().unwrap(), [conversation(1)]);
        assert!(feed.0.lock().unwrap().waiting.as_ref().is_some_and(|(_, m)| *m == conversation(5)));
        gate.release.add_permits(1);
        ingests.recv().await.expect("the waiting ingest starts");
        assert_eq!(*gate.started.lock().unwrap(), [conversation(1), conversation(5)]);
        assert!(feed.0.lock().unwrap().waiting.is_none());
    }
}
