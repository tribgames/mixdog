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
use mixdog_protocol::ThreadItem;
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
    /// `quotaAutoResumeEnabled()`: the config's `quotaAutoResume`, on unless set off.
    pub auto_resume: Arc<dyn Fn() -> bool + Send + Sync>,
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

/// `retainedRetryInput() !== null`: the last non-system model message is the failed turn's own
/// user message.
fn retained_retry_input(messages: &[Value]) -> bool {
    let Some(message) = messages.iter().rev().find(|m| m.get("role").and_then(Value::as_str) != Some("system")) else {
        return false;
    };
    let transcript = message.pointer("/meta/transcript");
    message.get("role").and_then(Value::as_str) == Some("user")
        && truthy(transcript.and_then(|t| t.get("messageId")))
        && transcript.and_then(|t| t.pointer("/completion/status")).and_then(Value::as_str) == Some("failed")
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
    async fn retained_retry(&self) -> bool {
        let messages: Vec<Value> = self.context.read().await.map(|rows| rows.into_iter().map(|(_, m)| m).collect()).unwrap_or_default();
        retained_retry_input(&messages)
    }

    /// What `beginQuotaSettlement` reads of the session.
    pub async fn resume_context(&self, auto_resume: bool) -> ResumeContext {
        ResumeContext {
            auto_resume,
            retained_retry: self.retained_retry().await,
            goal_reactivatable: !self.goal_id.is_empty(),
            route_provider: self.route_provider.clone(),
            route_model: self.route_model.clone(),
        }
    }

    /// `hasResumeInput(key)`.
    pub async fn has_resume_input(&self, key: &str) -> bool {
        if failed_turn_retry_prompt(&self.items, key).is_some() || self.retained_retry().await {
            return true;
        }
        if key.starts_with("turn:") {
            return false;
        }
        !self.quota.suspended(&self.session_id, key).is_empty() || !self.goal_id.is_empty()
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
