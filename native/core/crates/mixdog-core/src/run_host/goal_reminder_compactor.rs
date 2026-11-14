//! The run's compactor with the session's Goal reminder (`pre-send-compact.mjs`): the savings
//! preview prices the reminder the pass would attach (`preSendCompactDecision`), the pass marks and
//! reads it (`compactBeforeSend`) and gives it to the kept latest request (`goalReminderText`), and
//! the session's pending reminder is cleared once the compaction carried it: when its result was
//! adopted or the pass failed or was cancelled (`acknowledgeGoalReminder`), never when it was
//! skipped or changed nothing. The session's reading of a request the run has not measured comes through it too: its
//! provider pressure (`resolveContextTokensWithSource` over `session.contextPressureBaseline*`) and its unanchored mark.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::env::{CompactError, CompactOutput, CompactRequest, Compactor, SessionPressure};
use mixdog_agent::message::AgentMessage;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_session::session::run::RunPort;

pub struct GoalReminderCompactor {
    inner: Arc<dyn Compactor>,
    port: RunPort,
}

impl GoalReminderCompactor {
    pub fn new(inner: Arc<dyn Compactor>, port: RunPort) -> Self {
        Self { inner, port }
    }
}

/// The pending reminder a pass carries: acknowledged when it is dropped unless kept, so a cancelled
/// pass clears it as Node's aborted one does.
struct Carried {
    port: Option<RunPort>,
    revision: u64,
}

impl Carried {
    async fn acknowledge(mut self) {
        if let Some(port) = self.port.take() {
            let _ = port.acknowledge_goal_reminder(self.revision).await;
        }
    }

    fn keep(mut self) {
        self.port = None;
    }
}

impl Drop for Carried {
    fn drop(&mut self) {
        if let Some(port) = self.port.take() {
            let revision = self.revision;
            // The run's token fired: the acknowledgement still reaches the session.
            tokio::spawn(async move {
                let _ = port.closing().acknowledge_goal_reminder(revision).await;
            });
        }
    }
}

fn with_prefix<'a>(request: &CompactRequest<'a>, prefix: &'a str) -> CompactRequest<'a> {
    CompactRequest {
        messages: request.messages,
        budget_tokens: request.budget_tokens,
        trigger: request.trigger.clone(),
        require_reduction: request.require_reduction,
        reference_latest_attachments: request.reference_latest_attachments,
        active_turn: request.active_turn,
        latest_user_prefix: prefix,
    }
}

#[async_trait]
impl Compactor for GoalReminderCompactor {
    fn estimate_tokens(&self, messages: &[AgentMessage]) -> u64 {
        self.inner.estimate_tokens(messages)
    }

    async fn prepare(&self, messages: &[AgentMessage]) {
        self.inner.prepare(messages).await;
    }

    async fn session_pressure(&self, messages: &[AgentMessage], tools: &[ToolDefinition]) -> SessionPressure {
        // A reading that cannot be had prices as none: the run's own estimate stands.
        self.port.session_pressure(messages.to_vec(), tools.to_vec()).await.unwrap_or_default()
    }

    async fn reduces(&self, request: &CompactRequest<'_>) -> bool {
        // A reminder that cannot be read prices as none (`snapshotPendingGoalReminder` returns null).
        let prefix = self.port.compaction_goal_reminder(true).await.ok().flatten().map(|reminder| reminder.content).unwrap_or_default();
        self.inner.reduces(&with_prefix(request, &prefix)).await
    }

    async fn compact(&self, request: CompactRequest<'_>) -> Result<CompactOutput, CompactError> {
        let reminder = self.port.compaction_goal_reminder(false).await.ok().flatten();
        let prefix = reminder.as_ref().map(|reminder| reminder.content.clone()).unwrap_or_default();
        let carried = reminder.map(|reminder| Carried { port: Some(self.port.clone()), revision: reminder.revision });
        let outcome = self.inner.compact(with_prefix(&request, &prefix)).await;
        let adopted = match &outcome {
            Ok(output) => !output.skipped && output.messages != request.messages,
            Err(_) => true,
        };
        if let Some(carried) = carried {
            if adopted { carried.acknowledge().await } else { carried.keep() }
        }
        outcome
    }

    fn cache_expired(&self) -> bool {
        self.inner.cache_expired()
    }

    fn request_media(&self, messages: &[AgentMessage]) -> bool {
        self.inner.request_media(messages)
    }
}
