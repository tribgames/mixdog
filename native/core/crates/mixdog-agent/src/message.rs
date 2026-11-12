//! The run's transcript entry: a wire [`Message`] plus the metadata the loop
//! and the transcript need (why a user message exists, how a tool call ended).

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::MessageSource;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::ToolCall;

/// How a tool call ended, as the transcript and the UI show it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ToolKind {
    Normal,
    /// Served from the result cache: the body of an earlier identical call.
    CacheHit,
    Error,
    /// The call was answered without running (dedup, guard, limit).
    Skipped,
}

/// Node's `toolTiming` (`tool-batch/finalize.mjs`): the marks of one tool call, in wall-clock milliseconds.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ToolTiming {
    pub dispatch_started_at: i64,
    pub execution_started_at: i64,
    pub execution_completed_at: i64,
    pub postprocess_started_at: i64,
    pub result_completed_at: i64,
}

/// Why a user message is in the transcript. Only [`Source::Steering`] and
/// [`Source::StreamCutRecovery`] change the wire lowering.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    Steering,
    TaskNotification,
    TurnLimit,
    MaxOutputRecovery,
    StreamCutRecovery,
    RefusalRecovery,
    ContentFilterRecovery,
    /// A hook or reminder the runtime appended.
    Hook,
    /// A skill body a tool result delivered.
    Skill,
    /// Prose carried over from another app: the user's own voice whatever it
    /// looks like.
    Import,
    CompactSummary,
    CompactContext,
    ActiveTurnContinuation,
    CompactExecutionRecovery,
    /// The skills a compaction kept, reloaded or restored (compact-skill-window, -reload,
    /// -restore).
    CompactSkillWindow,
    CompactSkillReload,
    CompactSkillRestore,
    /// A skill the user named or the model selected (skill-context, skill-selection), the
    /// skill-update notice, a held request and a room line.
    SkillContext,
    SkillSelection,
    SkillUpdateNotice,
    HeldRequest,
    AgentRoom,
    /// Text-only copy compaction keeps of an omitted tool-call turn.
    CompactExecutionText,
    GoalContinuation,
    GoalCloseout,
    /// A schedule's output posted into its owner's home thread.
    ScheduleResult,
    /// The assistant `.` that closes an injected context turn.
    ContextAck,
}

impl Source {
    fn wire(self) -> Option<MessageSource> {
        match self {
            Self::Steering => Some(MessageSource::Steering),
            Self::StreamCutRecovery => Some(MessageSource::StreamCutRecovery),
            _ => None,
        }
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct AgentMessage {
    pub message: Message,
    pub source: Option<Source>,
    /// Recovery ladders: the attempt number the prompt belongs to.
    pub attempt: Option<u32>,
    pub submission_ids: Vec<String>,
    pub message_id: Option<String>,
    /// Tool messages only.
    pub tool_kind: Option<ToolKind>,
    /// Tool messages only: when the call ran (Node `toolTiming`); `None` for a call that did not run.
    pub tool_timing: Option<ToolTiming>,
    /// Assistant messages only.
    pub stop_reason: Option<StopReason>,
    /// Assistant messages only: reasoning text kept for the transcript view;
    /// it is not part of the wire message.
    pub reasoning: Option<String>,
    /// Assistant messages only: the tail reminder the request carried.
    pub turn_reminder: Option<String>,
    /// Assistant messages only (Node `providerMetadata`): the provider's
    /// per-turn binding, e.g. the account routing a later turn of the same
    /// conversation resumes. Passed through the loop untouched; reasoning
    /// items and reasoning content ride in `message`'s provider replay.
    pub provider_metadata: Option<mixdog_protocol::JsonValue>,
    /// User and tool messages: the effort the turn or step ran at (read from
    /// the stored row's metadata by the host).
    pub effort: Option<crate::effort::EffortSnapshot>,
    /// Tool messages only (Node `uiDiff`): the call's card diff, from the result's `meta.uiDiff`.
    /// The host stores it on the row; it is never wire text.
    pub ui_diff: Option<String>,
    /// The stored row this message was read from, exactly as stored (see the host message codec):
    /// whatever the typed fields do not hold (timings, usage counters, envelope extras) is written
    /// back from it, and a field the run changed is written over it.
    pub stored: Option<std::sync::Arc<serde_json::Map<String, mixdog_protocol::JsonValue>>>,
}

impl AgentMessage {
    pub fn new(message: Message) -> Self {
        Self {
            message,
            source: None,
            attempt: None,
            submission_ids: Vec::new(),
            message_id: None,
            tool_kind: None,
            tool_timing: None,
            stop_reason: None,
            reasoning: None,
            turn_reminder: None,
            provider_metadata: None,
            effort: None,
            ui_diff: None,
            stored: None,
        }
    }

    pub fn user(text: impl Into<String>) -> Self {
        Self::new(Message::new(Role::User, Content::Text(text.into())))
    }

    pub fn user_content(content: Content) -> Self {
        Self::new(Message::new(Role::User, content))
    }

    pub fn sourced(source: Source, text: impl Into<String>) -> Self {
        let mut message = Self::user(text);
        message.source = Some(source);
        message
    }

    pub fn with_attempt(mut self, attempt: u32) -> Self {
        self.attempt = Some(attempt);
        self
    }

    pub fn assistant(content: impl Into<String>, tool_calls: Vec<ToolCall>) -> Self {
        let mut message = Message::new(Role::Assistant, Content::Text(content.into()));
        message.tool_calls = tool_calls;
        Self::new(message)
    }

    pub fn tool_result(call_id: impl Into<String>, content: Content, kind: ToolKind) -> Self {
        let mut message = Message::new(Role::Tool, content);
        message.tool_call_id = Some(call_id.into());
        message.is_error = kind == ToolKind::Error;
        let mut entry = Self::new(message);
        entry.tool_kind = Some(kind);
        entry
    }

    pub fn tool_text(call_id: impl Into<String>, text: impl Into<String>, kind: ToolKind) -> Self {
        Self::tool_result(call_id, Content::Text(text.into()), kind)
    }

    pub fn role(&self) -> Role {
        self.message.role
    }

    pub fn tool_calls(&self) -> &[ToolCall] {
        &self.message.tool_calls
    }

    pub fn tool_call_id(&self) -> Option<&str> {
        self.message.tool_call_id.as_deref()
    }

    pub fn text(&self) -> String {
        content_text(&self.message.content)
    }

    /// The message as the provider receives it.
    pub fn wire(&self) -> Message {
        let mut message = self.message.clone();
        message.source = self.source.and_then(Source::wire);
        message.turn_reminder = self.turn_reminder.clone().filter(|text| !text.is_empty());
        message.account_routing = self.account_routing();
        message.sent_request_tail = self
            .stored
            .as_ref()
            .and_then(|row| row.get("meta"))
            .and_then(|meta| meta.get("sentRequestTail"))
            == Some(&mixdog_protocol::JsonValue::Bool(true));
        message
    }

    /// The stored `providerMetadata.accountRouting` (`{ provider, accountId, sessionAccountId }`), when it names
    /// a provider and an account.
    fn account_routing(&self) -> Option<mixdog_core_api::domain::provider::AccountRouting> {
        let routing = self.provider_metadata.as_ref()?.get("accountRouting")?;
        let text = |key: &str| routing.get(key).and_then(mixdog_protocol::JsonValue::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        Some(mixdog_core_api::domain::provider::AccountRouting {
            provider: text("provider")?,
            account_id: text("accountId")?,
            session_account_id: text("sessionAccountId"),
        })
    }

    /// Ids of the tool calls an assistant message carries: its call list
    /// first, then `tool_use` blocks of its native block list.
    pub fn assistant_call_ids(&self) -> Vec<String> {
        if self.message.role != Role::Assistant {
            return Vec::new();
        }
        let mut ids: Vec<String> = Vec::new();
        let mut add = |id: &str| {
            if !id.is_empty() && !ids.iter().any(|seen| seen == id) {
                ids.push(id.to_owned());
            }
        };
        for call in &self.message.tool_calls {
            add(&call.id);
        }
        if let Some(blocks) = self
            .message
            .assistant_blocks
            .as_ref()
            .and_then(|blocks| blocks.as_array())
        {
            for block in blocks {
                if block.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                    && let Some(id) = block.get("id").and_then(|id| id.as_str())
                {
                    add(id);
                }
            }
        }
        ids
    }
}

/// Text of a content value: text parts, `[Image]` for an image, other parts
/// dropped; joined with newlines.
pub fn content_text(content: &Content) -> String {
    match content {
        Content::Text(text) => text.clone(),
        Content::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text(text, _) => Some(text.as_str()),
                ContentPart::Image(_) => Some("[Image]"),
                ContentPart::File { .. } | ContentPart::Document { .. } => None,
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
    }
}
