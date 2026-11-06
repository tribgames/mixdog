//! The three store reads the task-report host needs (`TaskReportHost` over `SessionStore` and
//! `AgentRegistry`), answered from the session actor's own queue instead of Node's spool, claim
//! ledgers and lifecycle epochs (those exist because several Node processes shared files; here
//! one owner holds the queue and the log is its durable copy):
//!
//! - [`PendingQueue::pending_messages`]: `_getPendingMessagesForSession`, each queued entry once,
//!   in queue order, in the form Node's in-memory queue holds it.
//! - [`PendingQueue::owed_results`]: `owedAgentResults`, the undelivered completions of it.
//! - [`PendingQueue::queued_submission_ids`]: `readTuiSteeringPersist`'s submission ids.
//!
//! Where Node's answer depends on its multi-process mechanism the difference is in `decisions.md`
//! ("Pending-queue reads").

use std::sync::Arc;

use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ThreadId;
use mixdog_js::js_trim;
use mixdog_services::task_reports::chain::Owed;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::completions;
use super::delivered::DeliveredCompletions;
use super::delivered::task_notification_id;
use super::pending::normalize;
use super::state::Queued;

/// A steering row older than this is a leftover of a session that ended long ago
/// (`STALE_STEERING_RESTORE_TTL_MS`).
const STALE_STEERING_MS: i64 = 30 * 60 * 1000;

/// `isValidPendingSessionId`.
fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn clean(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(js_trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// `Number(value) || fallback` for a stored millisecond stamp.
fn stamp(value: Option<&Value>, fallback: i64) -> i64 {
    value.and_then(Value::as_f64).filter(|n| *n != 0.0 && !n.is_nan()).map_or(fallback, |n| n as i64)
}

/// The queue entry's text as `pendingMessageText` reads it; empty when it carries none.
fn entry_text(entry: &Value) -> String {
    normalize(entry).map(|n| js_trim(&n.text).to_owned()).unwrap_or_default()
}

fn is_completion(entry: &Value) -> bool {
    entry.get("notificationKind").and_then(Value::as_str) == Some(completions::KIND)
}

/// `completionExecutionId`, with the text read from the entry itself.
fn execution_id(entry: &Value) -> Option<String> {
    clean(entry.get("executionId"))
        .or_else(|| clean(entry.pointer("/execution/id")))
        .or_else(|| Some(task_notification_id(&entry_text(entry))).filter(|id| !id.is_empty()))
}

/// `normalizeExecution`.
fn execution(value: Option<&Value>, execution_id: Option<&str>) -> Option<Value> {
    let source = value.filter(|v| v.is_object());
    let field = |name: &str| clean(source.and_then(|s| s.get(name)));
    let (surface, status, result_type) = (field("surface"), field("status"), field("resultType"));
    let id = field("id").or_else(|| execution_id.map(str::to_owned));
    if id.is_none() && surface.is_none() && status.is_none() && result_type.is_none() {
        return None;
    }
    let mut out = Map::new();
    for (name, value) in [("surface", surface), ("id", id), ("status", status), ("resultType", result_type)] {
        if let Some(value) = value {
            out.insert(name.into(), Value::String(value));
        }
    }
    Some(Value::Object(out))
}

/// `pendingMessageQueueEntry` of a stored queue entry: the form Node's in-memory queue holds.
/// The entry's queue id is its id. `None` for an entry carrying no content.
pub fn pending_entry(qid: &str, entry: &Value, now: i64) -> Option<Value> {
    let normalized = normalize(entry)?;
    let mut out = Map::new();
    out.insert("content".into(), normalized.content);
    out.insert("text".into(), Value::String(normalized.text));
    out.insert("id".into(), Value::String(qid.to_owned()));
    let enqueued_at = stamp(entry.get("enqueuedAt"), now);
    out.insert("enqueuedAt".into(), json!(enqueued_at));
    if let Some(options) = entry.get("options").filter(|o| o.is_object()) {
        out.insert("options".into(), options.clone());
    }
    if entry.get("mode").and_then(Value::as_str) == Some(completions::MODE) {
        out.insert("mode".into(), json!(completions::MODE));
        if entry.get("origin").and_then(Value::as_str) == Some("channel") {
            out.insert("origin".into(), json!("channel"));
        }
    }
    if is_completion(entry) {
        out.insert("notificationKind".into(), json!(completions::KIND));
        out.insert("mode".into(), json!(completions::MODE));
        let id = execution_id(entry);
        if let Some(id) = &id {
            out.insert("executionId".into(), json!(id));
        }
        if let Some(execution) = execution(entry.get("execution"), id.as_deref()) {
            out.insert("execution".into(), execution);
        }
        if let Some(hop) = entry.get("hop").and_then(Value::as_i64).filter(|h| *h > 0) {
            out.insert("hop".into(), json!(hop));
        }
    }
    Some(Value::Object(out))
}

/// The session queue reads of one daemon.
pub struct PendingQueue {
    directory: Arc<SessionDirectory>,
    delivered: Arc<DeliveredCompletions>,
}

impl PendingQueue {
    /// `delivered` is the daemon's one registry, the same the writers record into.
    pub fn new(directory: Arc<SessionDirectory>, delivered: Arc<DeliveredCompletions>) -> Self {
        Self { directory, delivered }
    }

    fn now(&self) -> i64 {
        self.directory.deps().clock.now_ms()
    }

    /// The session's queued entries in queue order; none for an id Node's spool refuses or a
    /// session that does not exist. A stored session not loaded is opened for the read.
    async fn queue_of(&self, session_id: &str) -> Vec<Queued> {
        if !valid_session_id(session_id) {
            return Vec::new();
        }
        let thread = ThreadId::from(session_id);
        let handle = match self.directory.handle(&thread) {
            Some(handle) => handle,
            None => match self.directory.open_handle(&thread, &CallContext::internal("pending-read")).await {
                Ok(handle) => handle,
                Err(_) => return Vec::new(),
            },
        };
        handle.cell.queue.load().as_ref().clone()
    }

    /// `_getPendingMessagesForSession`: what is queued for the session, oldest first.
    pub async fn pending_messages(&self, session_id: &str) -> Vec<Value> {
        let now = self.now();
        self.queue_of(session_id).await.iter().filter_map(|q| pending_entry(&q.qid, &q.entry, now)).collect()
    }

    /// `completionIsDelivered`: the entry is a completion whose body already reached the model.
    pub fn completion_is_delivered(&self, entry: &Value) -> bool {
        is_completion(entry) && self.delivered.is_delivered(execution_id(entry).as_deref(), Some(&entry_text(entry)))
    }

    /// `owedAgentResults`: the completions queued for the session that no turn has taken and
    /// that did not already reach the model, as the notification bus delivers them.
    pub async fn owed_results(&self, session_id: &str) -> Vec<Owed> {
        self.pending_messages(session_id)
            .await
            .into_iter()
            .filter(|entry| is_completion(entry) && !self.completion_is_delivered(entry))
            .map(|entry| {
                let text = |value: Option<&Value>| value.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
                let execution_id = text(entry.get("executionId")).or_else(|| text(entry.pointer("/execution/id")));
                Owed {
                    text: text(entry.get("text")).or_else(|| text(entry.get("content"))).unwrap_or_default(),
                    meta: json!({
                        "type": "agent_task_result",
                        "execution_surface": text(entry.pointer("/execution/surface")).unwrap_or_else(|| "agent".into()),
                        "execution_id": execution_id,
                        "status": text(entry.pointer("/execution/status")),
                        "caller_session_id": session_id,
                    }),
                }
            })
            .collect()
    }

    /// `readTuiSteeringPersist`'s submission ids: the client submission ids of the session's
    /// queued prompts that are not a leftover of an ended session, in queue order.
    pub async fn queued_submission_ids(&self, session_id: &str) -> Vec<String> {
        let now = self.now();
        self.queue_of(session_id)
            .await
            .iter()
            .filter(|q| normalize(&q.entry).is_some())
            .filter(|q| {
                let at = stamp(q.entry.get("enqueuedAt"), 0);
                !(at > 0 && now - at > STALE_STEERING_MS)
            })
            .filter_map(|q| clean(q.entry.pointer("/options/clientSubmissionId")))
            .collect()
    }
}
