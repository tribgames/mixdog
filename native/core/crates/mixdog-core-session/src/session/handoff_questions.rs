//! The question copies a chat's approval queue holds for the sessions it handed work to
//! (`tui/session/tool-approval.mjs` `handoffQuestions` / `handoffRecords`), published as the
//! approvals section's `handoffQuestions`.
//!
//! A copy is `{ id, request, mirror }`: shown at its hand-off line for the user alone, outside the
//! queue of the chat's own requests, several at once. Answered here, the answer goes to the asking
//! session's queue. The last settled copy per asking session stays as an answered record (its
//! request with `record`, the result its `ask_user` call returned) until that session asks again;
//! a record is never answered here.
//!
//! This is the question half of Node's queue. The chat's own approvals and the mirrored cards of
//! other kinds belong to the approval book and are not held here: [`ApprovalQueue::offer`] and
//! [`ApprovalQueue::withdraw`] ignore a request that is not a question.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use mixdog_app_protocol::v2::thread::ThreadApprovals;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::{Section, ThreadState};
use serde_json::Value;
use tokio::sync::mpsc;

use super::delegated_host::{Answered, ApprovalQueue, Delegated};

#[cfg(test)]
mod tests;

/// Where the questions go: the approvals section of the holding thread.
pub trait QuestionPublisher: Send + Sync {
    /// `set({ handoffQuestions })`: the records, then the questions, each as its request.
    fn publish(&self, questions: Vec<Value>);
}

/// Publishes through the thread's section feed, in the order it was asked.
pub struct SectionPublisher {
    queue: mpsc::UnboundedSender<Vec<Value>>,
}

impl SectionPublisher {
    /// Needs a tokio runtime: one task per holding thread drains the publications in order.
    pub fn spawn(threads: Arc<dyn ThreadState>, thread: ThreadId) -> Self {
        let (queue, mut inbox) = mpsc::unbounded_channel::<Vec<Value>>();
        tokio::spawn(async move {
            while let Some(questions) = inbox.recv().await {
                let section = Section::Approvals(ThreadApprovals { handoff_questions: Some(questions), ..ThreadApprovals::default() });
                if let Err(error) = threads.publish(&thread, section).await {
                    tracing::warn!(thread = thread.as_str(), ?error, "handoff questions were not published");
                }
            }
        });
        Self { queue }
    }
}

impl QuestionPublisher for SectionPublisher {
    fn publish(&self, questions: Vec<Value>) {
        // The task ends with the thread's feed: a closed channel means nobody shows them.
        let _ = self.queue.send(questions);
    }
}

struct Held {
    id: String,
    request: Value,
    /// The copy as the host offered it: the answer goes through it. A record has none.
    mirror: Option<Delegated>,
}

#[derive(Default)]
struct Lists {
    questions: Vec<Held>,
    records: Vec<Held>,
}

pub struct HandoffQuestions {
    /// `state.sessionId`, read when asked: a runtime's session id can change.
    session_id: Arc<dyn Fn() -> String + Send + Sync>,
    publisher: Arc<dyn QuestionPublisher>,
    lists: Mutex<Lists>,
    disposed: AtomicBool,
}

/// `String(request.sessionId || '')`.
fn asking_session(request: &Value) -> String {
    match request.get("sessionId") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | Some(Value::Bool(false)) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

impl HandoffQuestions {
    pub fn new(session_id: Arc<dyn Fn() -> String + Send + Sync>, publisher: Arc<dyn QuestionPublisher>) -> Arc<Self> {
        Arc::new(Self { session_id, publisher, lists: Mutex::default(), disposed: AtomicBool::new(false) })
    }

    fn lists(&self) -> MutexGuard<'_, Lists> {
        self.lists.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `publishHandoffQuestions`.
    fn publish(&self, lists: &Lists) {
        self.publisher.publish(lists.records.iter().chain(&lists.questions).map(|held| held.request.clone()).collect());
    }

    /// `dropHandoffRecordOf(sessionId)`.
    fn drop_record_of(lists: &mut Lists, session_id: &str) {
        if let Some(at) = lists.records.iter().position(|held| asking_session(&held.request) == session_id) {
            lists.records.remove(at);
        }
    }

    /// The question branch of `finishToolApproval`: the user answered copy `id` here. The answer is
    /// forwarded to the owner (false when it had already settled), and the copy leaves; the owner's
    /// settle then withdraws it, which is what keeps it as the answered record. `None`: no such
    /// copy is held (a record is never answered here).
    pub fn finish_question(&self, id: &str, answered: &Answered) -> Option<bool> {
        let mirror = {
            let lists = self.lists();
            lists.questions.iter().find(|held| held.id == id)?.mirror.clone()
        };
        // Outside the lock: the owner's settle calls `withdraw` on this queue before it returns.
        let accepted = mirror.is_some_and(|mirror| (mirror.answer)(answered));
        let mut lists = self.lists();
        if let Some(at) = lists.questions.iter().position(|held| held.id == id) {
            lists.questions.remove(at);
            self.publish(&lists);
        }
        Some(accepted)
    }

    /// The closing branch of `denyAllToolApprovals`: the copies and records are dropped unanswered
    /// and silently with this runtime; the next runtime of the session adopts them again.
    pub fn close(&self) {
        self.disposed.store(true, Ordering::SeqCst);
        let mut lists = self.lists();
        lists.questions.clear();
        lists.records.clear();
    }
}

impl ApprovalQueue for HandoffQuestions {
    fn session_id(&self) -> String {
        (self.session_id)()
    }

    fn disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }

    /// `offerDelegatedApproval`, question branch.
    fn offer(&self, delegated: &Delegated) {
        if self.disposed() || delegated.session_id != (self.session_id)() {
            return;
        }
        if delegated.request.get("kind").and_then(Value::as_str) != Some("question") {
            return;
        }
        let mut lists = self.lists();
        if lists.questions.iter().any(|held| held.id == delegated.id) {
            return;
        }
        Self::drop_record_of(&mut lists, &asking_session(&delegated.request));
        lists.questions.push(Held { id: delegated.id.clone(), request: delegated.request.clone(), mirror: Some(delegated.clone()) });
        self.publish(&lists);
    }

    /// `withdrawDelegatedCopy`, question branch: the owner settled `id`. `result.record` (the
    /// string its `ask_user` call returned) keeps the copy as the answered record.
    fn withdraw(&self, id: &str, result: Option<&Value>) {
        let mut lists = self.lists();
        let Some(at) = lists.questions.iter().position(|held| held.id == id) else { return };
        let held = lists.questions.remove(at);
        if self.disposed() {
            return;
        }
        if let Some(record) = result.and_then(|result| result.get("record")).and_then(Value::as_str) {
            Self::drop_record_of(&mut lists, &asking_session(&held.request));
            let mut request = held.request.clone();
            request["record"] = Value::String(record.to_owned());
            lists.records.push(Held { id: id.to_owned(), request, mirror: None });
        }
        self.publish(&lists);
    }
}
