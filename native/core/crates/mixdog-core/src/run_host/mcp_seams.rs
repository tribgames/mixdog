//! The turn assembly's seams that WP-MCP owns, over its services: the post-tool hooks over the
//! hook bus (`SessionSeams::post_tool_dispatch`) and explicit skill selection
//! (`SessionSeams::skills`).

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_agent::env::GateCall;
use mixdog_agent::env::SkillSelector;
use mixdog_agent::env::ToolGate;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::Source;
use mixdog_agent::tools::ToolEnv;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_mcp::hook_bus::HookBus;
use mixdog_mcp::hook_bus::session::CommonOf;
use mixdog_mcp::hook_bus::session::PostCall;
use mixdog_mcp::hook_bus::session::SessionPostTool;
use mixdog_mcp::skill_select::Prompt;
use mixdog_mcp::skill_select::PromptPart;
use mixdog_mcp::skill_select::SkillNames;
use mixdog_mcp::skill_select::selection_of;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ToolCallId;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::hooks::BatchDecision;
use super::hooks::PostToolDispatch;
use super::hooks::PostToolEvent;

/// `PostToolDispatch` over the hook bus: the configured PostToolUse, PostToolUseFailure and
/// PostToolBatch handlers.
pub struct BusPostToolDispatch {
    inner: SessionPostTool,
}

impl BusPostToolDispatch {
    /// `common` gives a session's common payload fields (`hookCommonPayload`).
    pub fn new(bus: Arc<HookBus>, common: CommonOf) -> Self {
        Self { inner: SessionPostTool::new(bus, common) }
    }
}

fn call_of(event: &PostToolEvent) -> PostCall<'_> {
    PostCall { session_id: &event.session_id, name: &event.name, args: &event.args, cwd: &event.cwd, result: &event.result }
}

#[async_trait]
impl PostToolDispatch for BusPostToolDispatch {
    async fn post_tool(&self, event: &PostToolEvent) -> Option<JsonValue> {
        self.inner.tool(&call_of(event)).await
    }

    async fn post_failure(&self, event: &PostToolEvent) {
        self.inner.failure(&call_of(event)).await;
    }

    async fn post_batch(&self, session_id: &str, cwd: &str, tool_count: usize) -> Option<BatchDecision> {
        let outcome = self.inner.batch(session_id, cwd, tool_count).await?;
        Some(BatchDecision { blocked: outcome.blocked, reason: outcome.reason })
    }
}

/// The user's prompt as selection reads it.
pub fn prompt_of(content: &Content) -> Prompt {
    match content {
        Content::Text(text) => Prompt::Text(text.clone()),
        Content::Parts(parts) => Prompt::Parts(
            parts
                .iter()
                .map(|part| match part {
                    ContentPart::Text(text, _) => PromptPart::Text { text: Some(text.clone()), attachment_ref: None },
                    // A stored text attachment keeps its body in the blob store: no typed text.
                    ContentPart::File { text: Some(_), .. } => PromptPart::Text { text: None, attachment_ref: None },
                    _ => PromptPart::Other,
                })
                .collect(),
        ),
    }
}

/// Explicit skill selection for typed steering input (`prepareExplicitSkills`): each selected
/// skill is loaded through the session's `Skill` tool, and its result and body join the
/// transcript before the next request.
pub struct ExplicitSkillSelector {
    names: Arc<dyn SkillNames>,
    skill_tool: Arc<dyn Tool>,
    gate: Arc<dyn ToolGate>,
    env: ToolEnv,
    cancel: CancellationToken,
}

impl ExplicitSkillSelector {
    /// `env` and `cancel` are the run's, `gate` is the run's tool gate and `skill_tool` is the
    /// session's `Skill` tool.
    pub fn new(names: Arc<dyn SkillNames>, skill_tool: Arc<dyn Tool>, gate: Arc<dyn ToolGate>, env: ToolEnv, cancel: CancellationToken) -> Self {
        Self { names, skill_tool, gate, env, cancel }
    }

    fn context(&self, id: &str) -> ToolContext {
        let env = &self.env;
        ToolContext {
            call_id: ToolCallId::from(id),
            thread_id: env.thread_id.clone(),
            turn_id: env.turn_id.clone(),
            tool: self.skill_tool.spec().name.clone(),
            cwd: env.cwd.clone(),
            surface: env.surface,
            cancel: self.cancel.child_token(),
            deadline: env.deadline_of.as_ref().and_then(|f| f(self.skill_tool.spec())).map(|d| Instant::now() + d),
            progress: Arc::clone(&env.progress),
            io: env.io,
            approvals: Arc::clone(&env.approvals),
            files: Arc::clone(&env.files),
            processes: Arc::clone(&env.processes),
            options: Default::default(),
            review: None,
        }
    }
}

/// `String(summary)`: the tool's text parts, or its error text.
fn summary_of(parts: &[ToolPart]) -> String {
    parts
        .iter()
        .filter_map(|part| match part {
            ToolPart::Text(text) => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `LOADED_SKILL_RE`: the skill loaded.
pub fn loaded_skill(summary: &str) -> bool {
    summary.starts_with("Loaded skill: ") || summary.starts_with("Loaded built-in skill: ")
}

#[async_trait]
impl SkillSelector for ExplicitSkillSelector {
    async fn select(&self, content: &Content, transcript: &mut Vec<AgentMessage>) {
        // A session that cannot call Skill has nothing to select: preparing would only push a
        // refused-tool reminder into history on every matching turn.
        if self.gate.pre_dispatch_deny(&GateCall::new("Skill", json!({}))).is_some() {
            return;
        }
        let selection = selection_of(&prompt_of(content));
        if selection.is_empty() {
            return;
        }
        let available = match self.names.names(Path::new(self.env.cwd.as_path())).await {
            Ok(names) => names,
            Err(error) => {
                tracing::warn!(%error, "explicit skill selection could not read the skill catalog");
                return;
            }
        };
        for (index, name) in selection.resolve(&available).into_iter().enumerate() {
            if self.cancel.is_cancelled() {
                return;
            }
            let id = format!("skill-selection-{index}");
            let outcome = self.skill_tool.call(&self.context(&id), json!({ "name": name })).await;
            let (summary, follow_ups) = match outcome {
                Ok(output) => (summary_of(&output.parts), output.follow_up_messages),
                Err(error) => (error.message_for_model, Vec::new()),
            };
            transcript.push(AgentMessage::sourced(
                Source::SkillContext,
                format!("<system-reminder>\nExplicit skill selection result:\n{summary}\n</system-reminder>"),
            ));
            transcript.extend(follow_ups.into_iter().map(|m| AgentMessage::sourced(Source::Skill, m.text)));
        }
    }
}
