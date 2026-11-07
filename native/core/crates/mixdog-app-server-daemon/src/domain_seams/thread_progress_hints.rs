//! `ProgressHints`: the hint line of a thread, for the voice install's download progress (Node:
//! the session's `setProgressHint`, `voice-setup.mjs`). The hint is the thread's
//! `ThreadRuntime.progress_hint` in the runtime section, the field the running tool's hint
//! (`run_host/tool_progress.rs`) already publishes, through the same `Section::ProgressHint`, which
//! changes that field alone (a busy turn's runtime state is not reset); there is no second hint
//! mechanism.
//!
//! One publisher task serves one install: it takes the hints in the order they were shown and
//! publishes each that differs from the one on show, as `ToolHints` does. A clear removes the
//! hint and resolves once that is published. The task ends with the last handle.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::{Section, ThreadState};
use mixdog_rt::TaskClass;
use mixdog_services::voice::{ProgressHint, ProgressHints};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

/// Hints queued while a publish is in flight; the install throttles them to two a second.
const QUEUE: usize = 8;

pub struct ThreadProgressHints {
    threads: Arc<dyn ThreadState>,
}

impl ThreadProgressHints {
    pub fn new(threads: Arc<dyn ThreadState>) -> Self {
        Self { threads }
    }
}

impl ProgressHints for ThreadProgressHints {
    fn hint_for(&self, thread: &ThreadId) -> Arc<dyn ProgressHint> {
        let (tx, rx) = mpsc::channel(QUEUE);
        mixdog_rt::spawn("voice-progress-hint", TaskClass::Work, publish(self.threads.clone(), thread.clone(), rx));
        Arc::new(ThreadHint { tx })
    }
}

enum Message {
    Show(Value),
    Clear(oneshot::Sender<()>),
}

struct ThreadHint {
    tx: mpsc::Sender<Message>,
}

/// `{ text, tone, percent? }`, the shape of the client's sticky hint (`notice-surface.mjs`).
fn hint_value(text: String, percent: Option<u8>) -> Value {
    let mut hint = json!({ "text": text, "tone": "info" });
    if let Some(percent) = percent {
        hint["percent"] = json!(percent);
    }
    hint
}

#[async_trait]
impl ProgressHint for ThreadHint {
    fn show(&self, text: String, percent: Option<u8>) {
        // A full queue means a publish is stalled; the next hint (500 ms on) replaces this one.
        let _ = self.tx.try_send(Message::Show(hint_value(text, percent)));
    }

    async fn clear(&self) {
        let (ack, done) = oneshot::channel();
        if self.tx.send(Message::Clear(ack)).await.is_ok() {
            let _ = done.await;
        }
    }
}

async fn publish(threads: Arc<dyn ThreadState>, thread: ThreadId, mut rx: mpsc::Receiver<Message>) {
    let mut shown: Option<Value> = None;
    while let Some(message) = rx.recv().await {
        let (hint, ack) = match message {
            Message::Show(hint) => (Some(hint), None),
            Message::Clear(ack) => (None, Some(ack)),
        };
        if hint != shown {
            // A thread that is gone has no line to show it on.
            let _ = threads.publish(&thread, Section::ProgressHint(hint.clone())).await;
            shown = hint;
        }
        if let Some(ack) = ack {
            let _ = ack.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_store::schema::record::Header;
    use mixdog_tools::orch::util::PortError;
    use serde_json::Map;

    use super::*;

    #[derive(Default)]
    struct Published(Mutex<Vec<(String, Option<Value>)>>);

    #[async_trait]
    impl ThreadState for Published {
        async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
            Err(PortError::NotFound { target: thread.as_str().to_owned(), message: "no header".into() })
        }

        async fn patch_header(&self, thread: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
            Err(PortError::NotFound { target: thread.as_str().to_owned(), message: "no header".into() })
        }

        async fn patch_header_if(&self, thread: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
            Err(PortError::NotFound { target: thread.as_str().to_owned(), message: "no header".into() })
        }

        async fn publish(&self, thread: &ThreadId, section: Section) -> Result<(), PortError> {
            let Section::ProgressHint(hint) = section else { panic!("only the progress hint is published") };
            self.0.lock().unwrap().push((thread.as_str().to_owned(), hint));
            Ok(())
        }
    }

    #[tokio::test]
    async fn hints_are_published_in_order_on_the_runtime_section_and_cleared_once() {
        let threads = Arc::new(Published::default());
        let hint = ThreadProgressHints::new(threads.clone()).hint_for(&ThreadId("t1".into()));
        hint.show("⬇ Voice model ▓░░░░░ 9%".into(), Some(9));
        hint.show("⬇ Voice model ▓░░░░░ 9%".into(), Some(9));
        hint.show("⬇ Voice model …".into(), None);
        hint.clear().await;
        hint.clear().await;
        let got = threads.0.lock().unwrap().clone();
        assert_eq!(
            got,
            vec![
                ("t1".to_owned(), Some(json!({"text": "⬇ Voice model ▓░░░░░ 9%", "tone": "info", "percent": 9}))),
                ("t1".to_owned(), Some(json!({"text": "⬇ Voice model …", "tone": "info"}))),
                ("t1".to_owned(), None),
            ]
        );
    }
}