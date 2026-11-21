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
    /// How many working messages the cell holds the rows of, ahead of the early notices. The cell's rows are the one copy:
    /// a second one here, and a rebuild of every row on each commit, held a turn's whole output twice more.
    turn: usize,
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

    /// The working messages as the stored rows the turn will commit; call whenever they change. An early notice
    /// whose real result is now among them gives way to it. The messages of a turn only grow (its sink appends each as
    /// it commits), so the rows of those already published stay and only the new ones are made; a list shorter than the
    /// one published is a new list.
    pub fn publish(&self, messages: &[AgentMessage], rows: &dyn MessageRows) {
        let mut guard = self.state();
        let state = &mut *guard;
        if messages.len() < state.turn {
            state.turn = 0;
            state.answered.clear();
        }
        let added = &messages[state.turn..];
        let new_rows: Vec<Value> = added.iter().map(|m| rows.row(m)).collect();
        state.answered.extend(added.iter().filter_map(|m| m.tool_call_id().map(str::to_owned)));
        let answered = &state.answered;
        state.early.retain(|(id, _)| !answered.contains(id));
        let (held, early) = (state.turn, &state.early);
        self.inner.tx.send_modify(|cell| {
            // The cell is the rows' only owner unless a reader holds the list it took: only then are they copied.
            let cell = Arc::make_mut(cell);
            cell.truncate(held);
            cell.extend(new_rows);
            cell.extend(early.iter().map(|(_, row)| row.clone()));
        });
        state.turn = messages.len();
    }

    /// A streamed call settled (Node's `__earlyNotify` result): its row shows now, after the working messages, in
    /// completion order, and is replaced by the committed result. Never stored.
    pub fn early(&self, call_id: &str, row: Value) {
        let mut state = self.state();
        if state.answered.contains(call_id) || state.early.iter().any(|(id, _)| id == call_id) {
            return;
        }
        state.early.push((call_id.to_owned(), row.clone()));
        self.inner.tx.send_modify(|cell| Arc::make_mut(cell).push(row));
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

    /// Rows that count how often each was asked for.
    struct Counted(std::sync::atomic::AtomicUsize);
    impl MessageRows for Counted {
        fn row(&self, message: &AgentMessage) -> Value {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Rows.row(message)
        }
    }

    #[test]
    fn a_commit_makes_its_own_row_and_the_cell_keeps_the_rows_already_published() {
        let (tx, rx) = watch::channel(Arc::<Vec<Value>>::default());
        let run = LiveTurnPublisher::new(tx);
        let rows = Counted(Default::default());
        let mut turn = Vec::new();
        let mut first = std::ptr::null();
        for n in 0..50 {
            turn.push(AgentMessage::user(format!("message {n}")));
            run.publish(&turn, &rows);
            if n == 0 {
                first = rx.borrow()[0]["content"].as_str().unwrap().as_ptr();
            }
        }
        assert_eq!(rows.0.load(std::sync::atomic::Ordering::SeqCst), 50, "each working message is made a row once, not on every commit");
        let held = rx.borrow().clone();
        assert_eq!(held.len(), 50);
        assert_eq!(held[49]["content"], "message 49");
        assert_eq!(held[0]["content"].as_str().unwrap().as_ptr(), first, "the first row is the one first published, not a copy of it");
        // A reader's list is its own: the next commit leaves it as it was taken.
        turn.push(AgentMessage::user("message 50"));
        run.publish(&turn, &rows);
        assert_eq!((held.len(), rx.borrow().len()), (50, 51));
        // An early notice stays after the working messages as they grow, and a shorter list starts over.
        run.early("c9", json!({ "role": "tool", "toolCallId": "c9", "content": "early" }));
        turn.push(AgentMessage::user("message 51"));
        run.publish(&turn, &rows);
        assert_eq!((rx.borrow()[51]["content"].clone(), rx.borrow()[52]["content"].clone()), (json!("message 51"), json!("early")));
        run.publish(&turn[..1], &rows);
        assert_eq!(rx.borrow().iter().map(|row| row["content"].clone()).collect::<Vec<_>>(), [json!("message 0"), json!("early")]);
    }
}
