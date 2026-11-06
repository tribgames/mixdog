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

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use mixdog_js::{js_trim, value_to_string};
use mixdog_rt::KeyedChains;
use serde_json::{Map, Value, json};

use crate::goal::js::truthy;
use crate::goal::quota::{GoalQuotaResume, suspended_goal_id};
use crate::goal::js::Goal;
use mixdog_core_base::quota_resume::QuotaError;

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

/// `failedTurnRetryPrompt`: what retrying the turn submits — its prompt when it produced no
/// output, the continuation instruction when it did, `None` when the prompt carried no text (a
/// media-only prompt cannot be replayed).
pub fn failed_turn_retry_prompt(items: &[Value], turn_key: &str) -> Option<String> {
    const CHROME: [&str; 4] = ["user", "turndone", "statusdone", "notice"];
    let keys = transcript_turn_keys(items);
    let (mut prompt, mut sampled, mut has_attachments) = (String::new(), false, false);
    for (index, item) in items.iter().enumerate() {
        if keys[index] != turn_key {
            continue;
        }
        if is_kind(item, "user") && prompt.is_empty() {
            prompt = match item.get("text") {
                None | Some(Value::Null) => String::new(),
                Some(text) => js_trim(&value_to_string(text)).to_owned(),
            };
            has_attachments = item.get("images").and_then(Value::as_array).is_some_and(|images| !images.is_empty());
        }
        let kind = item.get("kind").filter(|kind| truthy(Some(kind))).map(value_to_string).unwrap_or_default();
        if !CHROME.contains(&kind.as_str()) {
            sampled = true;
        }
    }
    if prompt.is_empty() {
        return sampled.then(|| RETRY_CONTINUE_INSTRUCTION.to_owned());
    }
    // Transcript rows keep only attachment metadata, so a text-only replay would drop the
    // attachments and the rewind would delete the original row.
    if has_attachments && !sampled {
        return None;
    }
    Some(if sampled { RETRY_CONTINUE_INSTRUCTION.to_owned() } else { prompt })
}

pub const RETRY_CONTINUE_INSTRUCTION: &str = "Continue from where you left off.";

/// What the session knows when a turn closes on quota, for `beginQuotaSettlement`.
#[derive(Clone, Debug, Default)]
pub struct ResumeContext {
    /// `quotaAutoResumeEnabled()`.
    pub auto_resume: bool,
    /// `retainedRetryInput()` found the failed user message in the model history.
    pub retained_retry: bool,
    /// `runtime.goalStatus()?.id` is set and the runtime can reactivate a usage-limited Goal.
    pub goal_reactivatable: bool,
    /// `sessionRoute()`.
    pub route_provider: String,
    pub route_model: String,
}

/// What `beginQuotaSettlement` did about the failure.
#[derive(Clone, Debug, PartialEq)]
pub enum Begin {
    /// No failure to settle, no known reset, the setting off, or a cancel landed first.
    Nothing,
    /// The resume was queued; its entry.
    Queued(Box<mixdog_core_base::quota_resume::Entry>),
    /// The turn has nothing to replay: the session shows "This turn cannot be resumed
    /// automatically. Send a new message to continue." as a transcript warning.
    NotResumable,
}

struct Settlement {
    session_id: String,
    turn_key: String,
    epoch: u64,
}

/// One session's settlement guard. Everything that changes a session's resume state — queueing,
/// the Goal note, every cancel — runs one at a time per session id, so no cancel lands between
/// the epoch check and the write it guards (Node does both synchronously).
pub struct QuotaSettlement {
    quota: GoalQuotaResume,
    chains: Arc<KeyedChains>,
    epoch: AtomicU64,
    settlement: Mutex<Option<Settlement>>,
}

impl QuotaSettlement {
    pub fn new(quota: GoalQuotaResume) -> Self {
        Self { quota, chains: KeyedChains::new(), epoch: AtomicU64::new(0), settlement: Mutex::new(None) }
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<Settlement>> {
        self.settlement.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// Whether a failed turn is settling (the session's retry gate, `retryBlocked`).
    pub fn settling(&self) -> bool {
        self.slot().is_some()
    }

    /// `hasResumeInput`.
    fn has_resume_input(&self, session_id: &str, items: &[Value], turn_key: &str, context: &ResumeContext) -> bool {
        if context.retained_retry || failed_turn_retry_prompt(items, turn_key).is_some() {
            return true;
        }
        !turn_key.starts_with("turn:")
            && (!self.quota.suspended(session_id, turn_key).is_empty() || context.goal_reactivatable)
    }

    /// `beginQuotaSettlement`, at turn close with the failed turndone: remembers the turn with
    /// the epoch it ended under and, with a known reset and the setting on, queues its resume.
    pub async fn begin(&self, session_id: &str, items: &[Value], context: &ResumeContext) -> Result<Begin, QuotaError> {
        let failure = latest_quota_failure(items).filter(|_| !session_id.is_empty());
        let epoch = self.epoch();
        // The slot's guard ends before the first await: a session actor spawns this future.
        *self.slot() = failure.as_ref().map(|failure| Settlement { session_id: session_id.to_owned(), turn_key: failure.turn_key.clone(), epoch });
        let Some(failure) = failure else { return Ok(Begin::Nothing) };
        if failure.reset_at.is_none() || !context.auto_resume {
            return Ok(Begin::Nothing);
        }
        if !self.has_resume_input(session_id, items, &failure.turn_key, context) {
            return Ok(Begin::NotResumable);
        }
        let request = failure.schedule_request(session_id, &context.route_provider, &context.route_model);
        let _turn = self.chains.acquire(session_id).await;
        if self.epoch() != epoch {
            return Ok(Begin::Nothing);
        }
        Ok(Begin::Queued(Box::new(self.quota.schedule(&request).await?)))
    }

    /// `finishQuotaSettlement` after the Goal settled: records the Goal this failure suspended,
    /// unless a superseding cancel landed since the turn closed.
    pub async fn finish(&self, before: Option<&Goal>, settled: Option<&Goal>) -> Result<bool, QuotaError> {
        self.finish_goal(&suspended_goal_id(before, settled)).await
    }

    /// [`finish`](Self::finish) for a Goal id already decided. The epoch is read again once the
    /// session's turn is held: a cancel raises the epoch before it queues, so a cancel that
    /// arrived while this waited is seen, and one that arrives later clears the note after it.
    pub async fn finish_goal(&self, goal_id: &str) -> Result<bool, QuotaError> {
        let current = self.slot().take();
        let Some(current) = current.filter(|c| c.epoch == self.epoch() && !goal_id.is_empty()) else {
            return Ok(false);
        };
        let _turn = self.chains.acquire(&current.session_id).await;
        if current.epoch != self.epoch() {
            return Ok(false);
        }
        self.quota.note_goal(&current.session_id, &current.turn_key, goal_id).await
    }

    /// `cancelFor`: the epoch rises now, when the cancel is made; the resume and the Goal note
    /// go when the session's turn comes.
    fn cancel_for(&self, session_id: &str) -> impl Future<Output = Result<(), QuotaError>> + '_ {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let session_id = session_id.to_owned();
        async move {
            let _turn = self.chains.acquire(&session_id).await;
            self.quota.cancel(&session_id).await
        }
    }

    /// `cancelQuotaResumeOnUserInput`: new user input supersedes the stopped turn.
    pub fn cancel_on_user_input(&self, session_id: &str) -> impl Future<Output = Result<(), QuotaError>> + '_ {
        let cancel = (!session_id.is_empty()).then(|| self.cancel_for(session_id));
        async move {
            match cancel {
                Some(cancel) => cancel.await,
                None => Ok(()),
            }
        }
    }

    /// `supersedeQuotaResume`: a session clear or delete supersedes the wait.
    pub fn supersede(&self, session_id: &str) -> impl Future<Output = Result<(), QuotaError>> + '_ {
        self.cancel_on_user_input(session_id)
    }

    /// `cancelQuotaResume`: the explicit cancel drops the pending resume and keeps the Goal note.
    pub fn cancel_resume(&self, session_id: &str) -> impl Future<Output = Result<bool, QuotaError>> + '_ {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let session_id = session_id.to_owned();
        async move {
            let _turn = self.chains.acquire(&session_id).await;
            self.quota.cancel_entry(&session_id).await
        }
    }

    /// The session's turn, held by a test to stage a cancel against a waiting settlement.
    #[cfg(test)]
    pub(crate) async fn hold(&self, session_id: &str) -> mixdog_rt::ChainGuard {
        self.chains.acquire(session_id).await
    }
}
