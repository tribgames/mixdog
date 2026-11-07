//! The running turn's working messages (Node `session.liveTurnMessages`): the prompt, the
//! assistant's tool calls and the tool results of the turn so far, before they are committed.
//! The session cell owns the one copy, `RunStart.turn_messages`; the run publishes into it and
//! `RouteSession::live_turn_messages` reads it from the cell.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_agent::compact::execution_tail::MessageRows;
use mixdog_agent::message::AgentMessage;
use serde_json::Value;
use tokio::sync::watch;

/// The run's end of the cell's `turn_messages` channel. Cloneable: the loop's observer shares it with the sink.
#[derive(Clone)]
pub struct LiveTurnPublisher {
    inner: Arc<Inner>,
}

struct Inner {
    tx: watch::Sender<Arc<Vec<Value>>>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// The rows of the working messages, as last published.
    turn: Vec<Value>,
    /// The call ids whose result the working messages hold.
    answered: HashSet<String>,
    /// Early notices (a streamed call settled before its result commits), by call id, in completion order.
    early: Vec<(String, Value)>,
}

impl LiveTurnPublisher {
    pub fn new(tx: watch::Sender<Arc<Vec<Value>>>) -> Self {
        Self { inner: Arc::new(Inner { tx, state: Mutex::new(State::default()) }) }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn send(&self, state: &State) {
        let rows = state.turn.iter().cloned().chain(state.early.iter().map(|(_, row)| row.clone())).collect();
        self.inner.tx.send_replace(Arc::new(rows));
    }

    /// The working messages as the stored rows the turn will commit; call whenever they change. An early notice
    /// whose real result is now among them gives way to it.
    pub fn publish(&self, messages: &[AgentMessage], rows: &dyn MessageRows) {
        let mut state = self.state();
        state.turn = messages.iter().map(|m| rows.row(m)).collect();
        state.answered = messages.iter().filter_map(|m| m.tool_call_id().map(str::to_owned)).collect();
        let answered = state.answered.clone();
        state.early.retain(|(id, _)| !answered.contains(id));
        self.send(&state);
    }

    /// A streamed call settled (Node's `__earlyNotify` result): its row shows now, after the working messages, in
    /// completion order, and is replaced by the committed result. Never stored.
    pub fn early(&self, call_id: &str, row: Value) {
        let mut state = self.state();
        if state.answered.contains(call_id) || state.early.iter().any(|(id, _)| id == call_id) {
            return;
        }
        state.early.push((call_id.to_owned(), row));
        self.send(&state);
    }

    /// The turn ended (committed, failed or interrupted): nothing is live.
    pub fn clear(&self) {
        let mut state = self.state();
        *state = State::default();
        self.inner.tx.send_replace(Arc::default());
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

    #[test]
    fn an_early_notice_shows_after_the_working_messages_until_its_result_commits() {
        let (tx, rx) = watch::channel(Arc::<Vec<Value>>::default());
        let run = LiveTurnPublisher::new(tx);
        run.publish(&[AgentMessage::user("hi")], &Rows);
        run.early("c1", json!({ "role": "tool", "toolCallId": "c1", "content": "early" }));
        run.early("c1", json!({ "role": "tool", "toolCallId": "c1", "content": "again" }));
        assert_eq!(rx.borrow().len(), 2);
        assert_eq!(rx.borrow()[1]["content"], "early");
        let mut result = AgentMessage::tool_text("c1", "real", mixdog_agent::message::ToolKind::Normal);
        result.message.tool_call_id = Some("c1".into());
        run.publish(&[AgentMessage::user("hi"), result], &Rows);
        assert_eq!(rx.borrow().len(), 2, "the committed result replaces the early row");
        run.early("c1", json!({ "role": "tool", "toolCallId": "c1", "content": "late" }));
        assert_eq!(rx.borrow().len(), 2, "an answered call shows no early row");
    }
}
