//! The session side of the quota auto-resume (`tui/session/quota-resume.mjs`
//! `createQuotaResumeLane`): one [`QuotaSettlement`] per session actor, begun when a turn ends
//! on exhausted provider quota and finished once its Goal settled, the session state
//! `hasResumeInput` reads, and the `thread/quotaResume/*` seam ([`QuotaResumeSessions`]).

use std::future::Future;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::Config;
use mixdog_js::value_to_string;
use mixdog_protocol::ThreadItem;
use mixdog_app_protocol::v2::thread::TurnInput;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;

use super::SessionDirectory;
use super::actor::Inbox;
use super::run::ModelContext;
use mixdog_core_ports::ports::domain_sessions::QuotaFacts;
use mixdog_core_ports::ports::domain_sessions::QuotaResumeSessions;
use mixdog_core_goal::goal::js::Goal;
use mixdog_core_goal::goal::js::truthy;
use mixdog_core_goal::goal::quota::GoalQuotaResume;
use mixdog_core_goal::quota_settlement::QuotaSettlement;
use mixdog_core_goal::quota_settlement::ResumeContext;
use mixdog_core_goal::quota_settlement::failed_turn_retry_prompt;
use mixdog_core_goal::quota_settlement::latest_quota_failure;

/// The notice of a quota-failed turn nothing can replay.
pub const UNRESUMABLE: &str = "This turn cannot be resumed automatically. Send a new message to continue.";

/// The daemon-wide quota-resume queue as a session uses it.
#[derive(Clone)]
pub struct SessionQuota {
    /// The queue, with its Goal half.
    pub goals: GoalQuotaResume,
    /// `quotaAutoResumeEnabled()`: [`auto_resume_enabled`] in production.
    pub auto_resume: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl SessionQuota {
    /// The daemon's queue view: the switch is read from `config` at each use, so a settings
    /// change applies to the next quota stop.
    pub fn over_config(goals: GoalQuotaResume, config: Config) -> Self {
        Self { goals, auto_resume: Arc::new(move || auto_resume_enabled(&config)) }
    }
}

/// `quotaAutoResumeEnabled()` (`quota-resume-store.mjs`), read from the registered config key `quotaAutoResume`
/// (`desktop-services.md` A2/D1: the key is read from the `config` section and written with `config/value/write`; Node's
/// `quotaResume.autoResume` is moved to it by the migration); on unless it is the boolean `false`.
pub fn auto_resume_enabled(config: &Config) -> bool {
    config.get("quotaAutoResume") != Some(Value::Bool(false))
}

/// An actor's quota lane: its settlement guard, and its store calls in the order the actor made
/// them (Node runs each synchronously, so a cancel always lands before a later finish).
pub(crate) struct QuotaLane {
    pub settlement: Arc<QuotaSettlement>,
    tail: Option<tokio::task::JoinHandle<()>>,
    /// `goalBefore` of a turn that failed on quota, until its Goal settled.
    pub before: Option<Option<Goal>>,
}

impl QuotaLane {
    pub fn new(quota: &SessionQuota) -> Self {
        Self { settlement: Arc::new(QuotaSettlement::new(quota.goals.clone())), tail: None, before: None }
    }

    /// Runs `call` after every earlier call of this lane.
    pub fn call(&mut self, call: impl Future<Output = ()> + Send + 'static) {
        let tail = self.tail.take();
        self.tail = Some(tokio::spawn(async move {
            if let Some(tail) = tail {
                let _ = tail.await;
            }
            call.await;
        }));
    }
}

/// The transcript rows (`getState().items`) the quota reads walk, from the session's view
/// items: `kind` and `id`, a user row's `text` and `images`, a turn end's `status`, `quota`,
/// `attemptId` and `checkpointId`, and `archived`. Only `user`, `turndone` and the turn-chrome
/// kinds matter to those reads.
pub(crate) fn transcript_rows<'a>(items: impl Iterator<Item = &'a ThreadItem>) -> Vec<Value> {
    items
        .map(|item| {
            let mut row = serde_json::Map::new();
            row.insert("id".into(), json!(item.id()));
            let meta = match item {
                ThreadItem::UserMessage { display_text, details, meta, .. } => {
                    row.insert("kind".into(), json!("user"));
                    row.insert("text".into(), json!(display_text));
                    if !details.images.is_empty() {
                        row.insert("images".into(), json!(details.images));
                    }
                    meta
                }
                ThreadItem::TurnEnd { status, checkpoint_id, quota, meta, .. } => {
                    row.insert("kind".into(), json!("turndone"));
                    row.insert("status".into(), json!(status));
                    if let Some(checkpoint) = checkpoint_id {
                        row.insert("checkpointId".into(), json!(checkpoint));
                    }
                    if let Some(attempt) = meta.ext.get("attemptId") {
                        row.insert("attemptId".into(), attempt.clone());
                    }
                    if let Some(quota) = quota {
                        row.insert("quota".into(), Value::Object(quota.clone()));
                    }
                    meta
                }
                ThreadItem::StatusRow { kind, meta, .. } => {
                    row.insert("kind".into(), json!(kind));
                    meta
                }
                ThreadItem::RoomRow { room, meta, .. } => {
                    let user = json!(room.kind) == json!("user");
                    row.insert("kind".into(), json!(if user { "user" } else { "notice" }));
                    meta
                }
                ThreadItem::ContextCompaction { meta, .. } => {
                    row.insert("kind".into(), json!("statusdone"));
                    meta
                }
                ThreadItem::AgentMessage { meta, .. } => {
                    row.insert("kind".into(), json!("assistant"));
                    meta
                }
                ThreadItem::Reasoning { meta, .. } => {
                    row.insert("kind".into(), json!("thinking"));
                    meta
                }
                ThreadItem::ToolCall { meta, .. } => {
                    row.insert("kind".into(), json!("tool"));
                    meta
                }
                ThreadItem::SubAgentActivity { meta, .. } => {
                    row.insert("kind".into(), json!("agent"));
                    meta
                }
                ThreadItem::AgentJob { meta, .. } => {
                    row.insert("kind".into(), json!("agentjob"));
                    meta
                }
            };
            if let Some(archived) = meta.ext.get("archived") {
                row.insert("archived".into(), archived.clone());
            }
            Value::Object(row)
        })
        .collect()
}

/// `retainedRetryInput()`: the failed turn's own user message, resent as it is stored.
pub(crate) struct Retained {
    pub content: Value,
    pub message_id: String,
    pub attempt_id: Option<String>,
    /// The completions the message has recorded, the failure being retried last (`retainedUserTurn`).
    pub previous_completions: Vec<Value>,
}

/// What the retry row keeps of the failed message it resends (`retainedUserTurn`, `ask-turn-execute.mjs:38-61`):
/// its message id, and every failed completion it has recorded, as `meta.transcript.previousCompletions`.
#[derive(Clone)]
pub(crate) struct Prior {
    pub message_id: String,
    pub completions: Vec<Value>,
}

impl Retained {
    pub(crate) fn prior(&self) -> Prior {
        Prior { message_id: self.message_id.clone(), completions: self.previous_completions.clone() }
    }
}

/// `retainedRetryInput()`: the last non-system model message, when it is the failed turn's own
/// user message.
pub(crate) fn retained_retry_input(messages: &[Value]) -> Option<Retained> {
    let message = messages.iter().rev().find(|m| m.get("role").and_then(Value::as_str) != Some("system"))?;
    let transcript = message.pointer("/meta/transcript");
    let id = transcript.and_then(|t| t.get("messageId")).filter(|id| truthy(Some(id)));
    (message.get("role").and_then(Value::as_str) == Some("user")
        && id.is_some()
        && transcript.and_then(|t| t.pointer("/completion/status")).and_then(Value::as_str) == Some("failed"))
    .then(|| Retained {
        content: message.get("content").cloned().unwrap_or(Value::Null),
        message_id: value_to_string(id.expect("checked")),
        attempt_id: transcript.and_then(|t| t.pointer("/completion/attemptId")).and_then(Value::as_str).map(str::to_owned),
        previous_completions: previous_completions(transcript.expect("checked")),
    })
}

/// `[...(previousTranscript.previousCompletions || []), { ...completion, at: completion.at ?? previousTranscript.at }]`
/// (`retainedUserTurn`): `completion` is the failed one the caller checked. An `at` that is absent or null takes the
/// message's own; with neither, the entry has none.
fn previous_completions(transcript: &Value) -> Vec<Value> {
    let mut completions = transcript.get("previousCompletions").and_then(Value::as_array).cloned().unwrap_or_default();
    let completion = transcript.get("completion").and_then(Value::as_object).expect("checked");
    let own = completion.get("at").filter(|at| !at.is_null()).or_else(|| transcript.get("at").filter(|at| !at.is_null()));
    let mut entry: serde_json::Map<String, Value> = completion.iter().filter(|(key, _)| key.as_str() != "at").map(|(key, value)| (key.clone(), value.clone())).collect();
    if let Some(at) = own {
        entry.insert("at".into(), at.clone());
    }
    completions.push(Value::Object(entry));
    completions
}

/// The retry a resume admits (`retryFailedTurn(key)`'s queued entry): the turn the session
/// starts once the Goal is revived. `hidden`: the retained message is already on screen
/// (`suppressDisplay`).
#[derive(Clone)]
pub(crate) struct RetryTurn {
    pub input: TurnInput,
    pub hidden: bool,
    /// `failedTurnProvenance` of the turn it retries: stored on the retry row as `meta.provenance`.
    pub provenance: Option<Value>,
    /// The failed message a retained retry resends: the row keeps its id and its recorded completions.
    pub prior: Option<Prior>,
}

/// `failedTurnProvenance(messages, input)` as the object a retry row stores: the `{ source, origin }` of the
/// failed turn (`retry_turn_id` names its message when the retry does), `None` when it cannot be resolved.
pub(crate) fn failed_provenance(messages: &[Value], retry_turn_id: Option<&str>) -> Option<Value> {
    let input = match retry_turn_id {
        Some(id) => json!({ "retryFailedTurn": true, "retryTurnId": id }),
        None => json!({ "retryFailedTurn": true }),
    };
    mixdog_ai::warmer::plan::failed_turn_provenance(Some(&Value::Array(messages.to_vec())), &input).map(|(source, origin)| {
        let mut object = serde_json::Map::new();
        for (key, value) in [("source", source), ("origin", origin)] {
            if let Some(value) = value {
                object.insert(key.into(), value);
            }
        }
        Value::Object(object)
    })
}

/// What a retry reads of the model context in one read: the failed message to resend and the
/// failed turn's provenance (`failedTurnProvenance(preSession.messages, input)`).
pub(crate) struct RetryBasis {
    pub retained: Option<Retained>,
    pub provenance: Option<Value>,
}

/// `resumeGoal`'s `token`: the admission the Goal runtime asked of the session, and the retry
/// it let through.
#[derive(Default)]
pub(crate) struct ResumeToken {
    pub admitted: std::sync::Mutex<Option<Option<RetryTurn>>>,
}

/// `latestFailedTurnKey`: the turn key of the failed turndone that ends the transcript, when no
/// later turn has begun; empty otherwise.
pub(crate) fn latest_failed_turn_key(items: &[Value]) -> String {
    for (index, item) in items.iter().enumerate().rev() {
        let kind = item.get("kind").and_then(Value::as_str);
        if kind == Some("user") || item.get("archived") == Some(&json!(true)) {
            return String::new();
        }
        if kind != Some("turndone") {
            continue;
        }
        let failed = item.get("status").and_then(Value::as_str).is_some_and(|status| status.to_lowercase() == "failed");
        if !failed {
            return String::new();
        }
        return mixdog_core_goal::quota_settlement::transcript_turn_keys(items).swap_remove(index);
    }
    String::new()
}

/// What `hasResumeInput` reads of the session, taken by the actor.
pub(crate) struct ResumeCheck {
    pub session_id: String,
    pub items: Vec<Value>,
    pub context: ModelContext,
    /// `runtime.goalStatus()?.id`.
    pub goal_id: String,
    pub quota: GoalQuotaResume,
    /// The session's own route (`sessionRoute()`).
    pub route_provider: String,
    pub route_model: String,
}

impl ResumeCheck {
    /// `retainedRetryInput() !== null` over the session's model context.
    pub(crate) async fn retained_retry(&self) -> Option<Retained> {
        let messages: Vec<Value> = self.context.read().await.map(|rows| rows.into_iter().map(|(_, m)| m).collect()).unwrap_or_default();
        retained_retry_input(&messages)
    }

    /// The retry's inputs from one read of the model context.
    pub(crate) async fn retry_basis(&self) -> RetryBasis {
        let messages: Vec<Value> = self.context.read().await.map(|rows| rows.into_iter().map(|(_, m)| m).collect()).unwrap_or_default();
        let retained = retained_retry_input(&messages);
        let provenance = failed_provenance(&messages, retained.as_ref().map(|retained| retained.message_id.as_str()));
        RetryBasis { retained, provenance }
    }

    /// What `beginQuotaSettlement` reads of the session.
    pub async fn resume_context(&self, auto_resume: bool) -> ResumeContext {
        ResumeContext {
            auto_resume,
            retained_retry: self.retained_retry().await.is_some(),
            goal_reactivatable: !self.goal_id.is_empty(),
            route_provider: self.route_provider.clone(),
            route_model: self.route_model.clone(),
        }
    }

    /// `hasResumeInput(key)`.
    pub async fn has_resume_input(&self, key: &str) -> bool {
        if failed_turn_retry_prompt(&self.items, key).is_some() || self.retained_retry().await.is_some() {
            return true;
        }
        if key.starts_with("turn:") {
            return false;
        }
        !self.quota.suspended(&self.session_id, key).is_empty() || !self.goal_id.is_empty()
    }
}

/// What `fireQuotaResume({ generation })` decides before it acts, in Node's order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FireStep {
    /// No queued entry of this generation, or its turn is already claimed by a retry.
    Stale,
    /// Something runs, settles, closes or is queued: the scheduler re-checks later.
    Busy,
    /// The entry's turn is no longer the latest quota failure: the entry goes.
    Superseded,
    /// Nothing a resume could replay: the entry goes and the session hears why.
    Unreplayable,
    /// The Goal the failure `turn_key` suspended is revived, with the retry if there is one.
    ResumeGoal { turn_key: String, goal_id: String },
    /// The failed turn `turn_key` is retried.
    Retry { turn_key: String },
}

/// The session state `fireQuotaResume` reads.
pub(crate) struct FireFacts<'a> {
    /// The queued entry: its turn key and generation.
    pub entry: Option<(&'a str, u64)>,
    /// `retryBlocked()`.
    pub blocked: bool,
    /// The transcript rows (`getState().items`).
    pub items: &'a [Value],
    /// `retainedRetryInput() !== null`.
    pub retained: bool,
    /// `quotaSuspendedGoal(id, turnKey)`.
    pub suspended: &'a dyn Fn(&str) -> String,
    /// `retryClaim === claim` for the turn key.
    pub claimed: &'a dyn Fn(&str) -> bool,
}

/// `fireQuotaResume({ generation })`'s decision (`quota-resume.mjs:339`).
pub(crate) fn fire_step(generation: u64, facts: &FireFacts) -> FireStep {
    let Some((turn_key, _)) = facts.entry.filter(|(_, queued)| *queued == generation) else {
        return FireStep::Stale;
    };
    if facts.blocked {
        return FireStep::Busy;
    }
    if latest_quota_failure(facts.items).is_none_or(|failure| failure.turn_key != turn_key) {
        return FireStep::Superseded;
    }
    let goal_id = (facts.suspended)(turn_key);
    // A user turn replays its prompt; an automatic Goal turn has no user row and resumes as its
    // Goal's next continuation.
    if !facts.retained && failed_turn_retry_prompt(facts.items, turn_key).is_none() && goal_id.is_empty() {
        return FireStep::Unreplayable;
    }
    if (facts.claimed)(turn_key) {
        return FireStep::Stale;
    }
    let turn_key = turn_key.to_owned();
    if goal_id.is_empty() { FireStep::Retry { turn_key } } else { FireStep::ResumeGoal { turn_key, goal_id } }
}

/// The text a session failure carries for the quota-resume clock: the failure's own message
/// (Node's `error.message`), else the error as logged.
pub(crate) fn failure_text(error: &CoreError) -> String {
    match error {
        CoreError::DomainError { message: Some(message), .. } => message.to_string(),
        other => other.to_string(),
    }
}

fn gone() -> CoreError {
    CoreError::Internal { incident_id: "session-quota-gone".into() }
}

#[async_trait]
impl QuotaResumeSessions for SessionDirectory {
    async fn facts(&self, thread: &ThreadId) -> Result<QuotaFacts, CoreError> {
        let handle = self.open_handle(thread, &CallContext::internal("quota-resume")).await?;
        let (tx, rx) = oneshot::channel();
        handle.inbox.send(Inbox::QuotaFacts { tx }).await.map_err(|_| gone())?;
        let check = rx.await.map_err(|_| gone())?;
        let failure = latest_quota_failure(&check.items);
        let resumable = match &failure {
            Some(failure) => check.has_resume_input(&failure.turn_key).await,
            None => false,
        };
        let failure = failure.map(|failure| mixdog_core_ports::ports::domain_sessions::QuotaFailure {
            reset_at: failure.reset_at.and_then(|at| match mixdog_js::json_number(at) {
                Value::Number(at) => Some(at),
                _ => None,
            }),
            turn_key: failure.turn_key,
            provider: failure.provider,
            model: failure.model,
        });
        Ok(QuotaFacts { failure, resumable, route_provider: check.route_provider, route_model: check.route_model })
    }

    /// `cancelQuotaResume`'s epoch: a thread not loaded has no settlement to stop.
    async fn cancelled(&self, thread: &ThreadId) -> Result<(), CoreError> {
        let Some(handle) = self.handle(thread) else {
            return Ok(());
        };
        let (tx, rx) = oneshot::channel();
        if handle.inbox.send(Inbox::QuotaCancelled { tx }).await.is_ok() {
            let _ = rx.await;
        }
        Ok(())
    }
}
