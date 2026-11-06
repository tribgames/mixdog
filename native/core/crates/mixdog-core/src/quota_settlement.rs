//! The quota-settlement guard of a session (`tui/session/quota-resume.mjs`): a turn that ends
//! on exhausted provider quota is settling between its failed turndone, where the resume is
//! queued, and its Goal settlement, where the suspended Goal is recorded. Every cancel that
//! supersedes the turn raises the epoch, so a cancel landing inside that window also keeps the
//! settlement from recording the Goal.
//!
//! The turn key is the transcript's (`runtime/shared/transcript-turn-keys.mjs`): a turn is the
//! rows from its `user` row to its `turndone`, named `turn:<first row key>` while open and
//! `attempt:<id>` / `checkpoint:<id>` once the turndone carries an identity.
//!
//! Session use: `begin` when the failed turndone is published (queue the resume from the
//! returned failure), `finish` after the Goal settled, `supersede` / `cancel_on_user_input` /
//! `cancel_resume` for every cancel; one guard per session actor.

use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::{AtomicU64, Ordering};

use mixdog_js::value_to_string;
use serde_json::{Map, Value, json};

use crate::goal::js::truthy;
use crate::goal::quota::{GoalQuotaResume, suspended_goal_id};
use crate::goal::js::Goal;
use crate::quota_resume::QuotaError;

fn text(value: Option<&Value>) -> String {
    value.map(value_to_string).unwrap_or_default()
}

fn stable_item_key(item: &Value, index: usize) -> String {
    match item.get("id") {
        Some(id) if !id.is_null() => value_to_string(id),
        _ => {
            let kind = item.get("kind").filter(|v| truthy(Some(v)));
            let label = ["text", "label", "status"].iter().filter_map(|key| item.get(key)).find(|v| truthy(Some(v)));
            format!("{}:{}:{index}", kind.map_or("item".to_owned(), value_to_string), text(label))
        }
    }
}

fn is_kind(item: &Value, kind: &str) -> bool {
    item.get("kind").and_then(Value::as_str) == Some(kind)
}

fn non_empty_str<'a>(item: &'a Value, key: &str) -> Option<&'a str> {
    item.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `transcriptTurnKeys`.
pub fn transcript_turn_keys(items: &[Value]) -> Vec<String> {
    let mut keys: Vec<String> = Vec::with_capacity(items.len());
    let mut active: Option<String> = None;
    let mut start = 0;
    for (index, item) in items.iter().enumerate() {
        if is_kind(item, "user") {
            active = Some(format!("turn:{}", stable_item_key(item, index)));
            start = index;
        }
        let turn = active.get_or_insert_with(|| {
            start = index;
            format!("segment:{}", stable_item_key(item, index))
        });
        keys.push(turn.clone());
        if is_kind(item, "turndone") {
            let identity = non_empty_str(item, "attemptId")
                .map(|id| format!("attempt:{id}"))
                .or_else(|| non_empty_str(item, "checkpointId").map(|id| format!("checkpoint:{id}")));
            if let Some(identity) = identity {
                for key in &mut keys[start..=index] {
                    key.clone_from(&identity);
                }
            }
            active = None;
        }
    }
    keys
}

/// The failed turndone that ended the transcript on exhausted provider quota
/// (`latestQuotaFailure`).
#[derive(Clone, Debug, PartialEq)]
pub struct QuotaFailure {
    pub turn_key: String,
    pub provider: String,
    pub model: String,
    pub reset_at: Option<f64>,
}

impl QuotaFailure {
    /// The `scheduleQuotaResumeEntry` request of this failure (`queueResume`): keyed by the
    /// failed turn and carrying the session's own route.
    pub fn schedule_request(&self, session_id: &str, route_provider: &str, route_model: &str) -> Value {
        let mut request = Map::new();
        request.insert("sessionId".into(), json!(session_id));
        request.insert("turnKey".into(), json!(self.turn_key));
        request.insert("provider".into(), json!(self.provider));
        request.insert("model".into(), json!(self.model));
        request.insert("resetAt".into(), self.reset_at.map_or(Value::Null, mixdog_js::json_number));
        request.insert("routeProvider".into(), json!(route_provider));
        request.insert("routeModel".into(), json!(route_model));
        Value::Object(request)
    }
}

/// `latestQuotaFailure`.
pub fn latest_quota_failure(items: &[Value]) -> Option<QuotaFailure> {
    for (index, item) in items.iter().enumerate().rev() {
        // A turn a compaction archived is no longer the model's to resume.
        if is_kind(item, "user") || item.get("archived") == Some(&json!(true)) {
            return None;
        }
        if !is_kind(item, "turndone") {
            continue;
        }
        let status = item.get("status").filter(|v| truthy(Some(v)));
        let quota = item.get("quota").filter(|v| truthy(Some(v)));
        let provider = quota.and_then(|q| q.get("provider")).and_then(Value::as_str);
        let (true, Some(quota), Some(provider)) = (text(status).to_lowercase() == "failed", quota, provider) else {
            return None;
        };
        let turn_key = transcript_turn_keys(items).swap_remove(index);
        if turn_key.is_empty() {
            return None;
        }
        return Some(QuotaFailure {
            turn_key,
            provider: provider.to_owned(),
            model: quota.get("model").and_then(Value::as_str).unwrap_or_default().to_owned(),
            reset_at: quota.get("resetAt").and_then(Value::as_f64),
        });
    }
    None
}

struct Settlement {
    session_id: String,
    turn_key: String,
    epoch: u64,
}

pub struct QuotaSettlement {
    quota: GoalQuotaResume,
    epoch: AtomicU64,
    settlement: Mutex<Option<Settlement>>,
}

impl QuotaSettlement {
    pub fn new(quota: GoalQuotaResume) -> Self {
        Self { quota, epoch: AtomicU64::new(0), settlement: Mutex::new(None) }
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<Settlement>> {
        self.settlement.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether a failed turn is settling (the session's retry gate, `retryBlocked`).
    pub fn settling(&self) -> bool {
        self.slot().is_some()
    }

    /// `beginQuotaSettlement`'s recording half: the turn that ended on quota is remembered with
    /// the epoch it ended under. The failure comes back for the caller to queue the resume from.
    pub fn begin(&self, session_id: &str, items: &[Value]) -> Option<QuotaFailure> {
        let failure = latest_quota_failure(items);
        let mut slot = self.slot();
        *slot = None;
        let failure = failure.filter(|_| !session_id.is_empty())?;
        *slot = Some(Settlement {
            session_id: session_id.to_owned(),
            turn_key: failure.turn_key.clone(),
            epoch: self.epoch.load(Ordering::SeqCst),
        });
        Some(failure)
    }

    /// `finishQuotaSettlement` after the Goal settled: records the Goal the failure suspended,
    /// unless a superseding cancel landed since the turn closed.
    pub async fn finish(&self, before: Option<&Goal>, settled: Option<&Goal>) -> Result<bool, QuotaError> {
        self.finish_goal(&suspended_goal_id(before, settled)).await
    }

    /// [`finish`](Self::finish) for a Goal id already decided.
    pub async fn finish_goal(&self, goal_id: &str) -> Result<bool, QuotaError> {
        let current = self.slot().take();
        let Some(current) = current.filter(|c| c.epoch == self.epoch.load(Ordering::SeqCst)) else {
            return Ok(false);
        };
        self.quota.note_goal(&current.session_id, &current.turn_key, goal_id).await
    }

    /// `cancelFor`: a cancel that supersedes the turn — the resume and the Goal note both go.
    async fn cancel_for(&self, session_id: &str) -> Result<(), QuotaError> {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.quota.cancel(session_id).await
    }

    /// `cancelQuotaResumeOnUserInput`: new user input supersedes the stopped turn.
    pub async fn cancel_on_user_input(&self, session_id: &str) -> Result<(), QuotaError> {
        if session_id.is_empty() {
            return Ok(());
        }
        self.cancel_for(session_id).await
    }

    /// `supersedeQuotaResume`: a session clear or delete supersedes the wait.
    pub async fn supersede(&self, session_id: &str) -> Result<(), QuotaError> {
        self.cancel_on_user_input(session_id).await
    }

    /// `cancelQuotaResume`: the explicit cancel drops the pending resume and keeps the Goal note.
    pub async fn cancel_resume(&self, session_id: &str) -> Result<bool, QuotaError> {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.quota.cancel_entry(session_id).await
    }
}
