//! The running turn's working messages (Node `session.liveTurnMessages`): the prompt, the
//! assistant's tool calls and the tool results of the turn so far, before they are committed.
//! The session cell owns the one copy, `RunStart.turn_messages`; the run publishes into it and
//! `RouteSession::live_turn_messages` reads it from the cell.

use std::sync::Arc;

use mixdog_agent::compact::execution_tail::MessageRows;
use mixdog_agent::message::AgentMessage;
use serde_json::Value;
use tokio::sync::watch;

/// The run's end of the cell's `turn_messages` channel.
pub struct LiveTurnPublisher {
    tx: watch::Sender<Arc<Vec<Value>>>,
}

impl LiveTurnPublisher {
    pub fn new(tx: watch::Sender<Arc<Vec<Value>>>) -> Self {
        Self { tx }
    }

    /// The working messages as the stored rows the turn will commit; call whenever they change.
    pub fn publish(&self, messages: &[AgentMessage], rows: &dyn MessageRows) {
        self.tx.send_replace(Arc::new(messages.iter().map(|m| rows.row(m)).collect()));
    }

    /// The turn ended (committed, failed or interrupted): nothing is live.
    pub fn clear(&self) {
        self.tx.send_replace(Arc::default());
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::provider::Content;
    use serde_json::json;

    use super::*;

    struct Rows;
    impl MessageRows for Rows {
        fn row(&self, message: &AgentMessage) -> Value {
            match &message.message.content {
                Content::Text(t) => json!({ "role": "user", "content": t }),
                Content::Parts(_) => Value::Null,
            }
        }
    }

    #[test]
    fn the_cell_reads_what_the_run_last_published_and_nothing_after_it_ends() {
        let (tx, rx) = watch::channel(Arc::<Vec<Value>>::default());
        let run = LiveTurnPublisher::new(tx);
        assert!(rx.borrow().is_empty());
        run.publish(&[AgentMessage::user("hi")], &Rows);
        assert_eq!(**rx.borrow(), vec![json!({ "role": "user", "content": "hi" })]);
        run.clear();
        assert!(rx.borrow().is_empty());
    }
}
