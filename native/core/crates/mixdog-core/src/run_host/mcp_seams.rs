//! The turn assembly's seams that WP-MCP owns, over its services: the post-tool hooks over the
//! hook bus (`SessionSeams::post_tool_dispatch`) and explicit skill selection
//! (`SessionSeams::skills`).

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_agent::env::BoundAccount;
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
use mixdog_ai::service::admin_models::developer_option_enabled;
use mixdog_mcp::McpHub;
use mixdog_mcp::hub::normalize_scope;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::ToolResolver;
use mixdog_core_api::ids::ThreadId;
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

use super::session_tools::SkillsListed;
use mixdog_core_config::config::Config;
use mixdog_core_ports::ports::gate::GateEnv;
use mixdog_core_ports::ports::gate::GateRun;
use super::hooks::BatchDecision;
use super::hooks::PostToolAnswer;
use super::hooks::PostToolDispatch;
use super::hooks::PostToolEvent;
use super::hooks::StopDecision;

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
    PostCall { session_id: &event.session_id, call_id: &event.call_id, name: &event.name, args: &event.args, cwd: &event.cwd, result: &event.result }
}

#[async_trait]
impl PostToolDispatch for BusPostToolDispatch {
    async fn post_tool(&self, event: &PostToolEvent) -> PostToolAnswer {
        let decided = self.inner.tool(&call_of(event)).await;
        PostToolAnswer { updated_output: decided.updated_tool_output, context: decided.additional_context, feedback: decided.blocked.then_some(decided.reason).flatten() }
    }

    async fn post_failure(&self, event: &PostToolEvent) {
        self.inner.failure(&call_of(event)).await;
    }

    async fn post_batch(&self, session_id: &str, cwd: &str, tool_count: usize) -> Option<BatchDecision> {
        let outcome = self.inner.batch(session_id, cwd, tool_count).await?;
        Some(BatchDecision { blocked: outcome.blocked, reason: outcome.reason })
    }

    async fn stop(&self, session_id: &str, cwd: &str, stop_hook_active: bool) -> StopDecision {
        let decided = self.inner.stop(session_id, cwd, stop_hook_active).await;
        // `continue: false` ends the turn even when a handler also blocked the stop (Claude Code's `preventContinuation`).
        StopDecision { blocked: decided.blocked && !decided.prevent_continuation, reason: decided.reason }
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

/// What the `Skill` tool would deliver for a skill at a folder now (`currentSkillDelivery(name, cwd).body`): the
/// injected `<skill>` body, or `None` when the skill no longer loads there (refused, or removed).
#[async_trait]
pub trait SkillDeliveries: Send + Sync {
    async fn delivery(&self, name: &str, cwd: &Path) -> Result<Option<String>, String>;
}

#[async_trait]
impl SkillDeliveries for SkillCatalog {
    async fn delivery(&self, name: &str, cwd: &Path) -> Result<Option<String>, String> {
        Ok(match self.load(name, cwd).await.map_err(|error| error.to_string())? {
            mixdog_mcp::skill_catalog::SkillLoad::Loaded(resource) => {
                Some(mixdog_tools::orch::skill::result_envelope(name, &resource.body, Some(resource.dir.as_str())))
            }
            _ => None,
        })
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
    /// The turn's trusted selection input (`selection` of `prepareExplicitSkills`): when given, even empty,
    /// it is read instead of the prompt.
    selection: Option<String>,
    /// What each loaded skill delivers now, for the turn's skill-update notices; `None` announces nothing.
    deliveries: Option<Arc<dyn SkillDeliveries>>,
}

impl ExplicitSkillSelector {
    /// `env` and `cancel` are the run's, `gate` is the run's tool gate and `skill_tool` is the
    /// session's `Skill` tool.
    pub fn new(names: Arc<dyn SkillNames>, skill_tool: Arc<dyn Tool>, gate: Arc<dyn ToolGate>, env: ToolEnv, cancel: CancellationToken) -> Self {
        Self { names, skill_tool, gate, env, cancel, selection: None, deliveries: None }
    }

    #[must_use]
    pub fn with_deliveries(mut self, deliveries: Option<Arc<dyn SkillDeliveries>>) -> Self {
        self.deliveries = deliveries;
        self
    }

    #[must_use]
    pub fn with_selection(mut self, selection: Option<String>) -> Self {
        self.selection = selection;
        self
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
    async fn select(&self, content: &Content, initial: bool, transcript: &mut Vec<AgentMessage>) -> Vec<String> {
        let mut applied = Vec::new();
        // A session that cannot call Skill has nothing to select: preparing would only push a
        // refused-tool reminder into history on every matching turn.
        if self.gate.pre_dispatch_deny(&GateCall::new("Skill", json!({}))).is_some() {
            return applied;
        }
        // The trusted selection is the turn's own prompt's (`runAskAgentLoop`); a steered prompt selects from itself.
        let trusted = self.selection.clone().filter(|_| initial);
        let selection = selection_of(&trusted.map_or_else(|| prompt_of(content), Prompt::Text));
        if selection.is_empty() {
            return applied;
        }
        let available = match self.names.names(Path::new(self.env.cwd.as_path())).await {
            Ok(names) => names,
            Err(error) => {
                tracing::warn!(%error, "explicit skill selection could not read the skill catalog");
                return applied;
            }
        };
        for (index, name) in selection.resolve(&available).into_iter().enumerate() {
            if self.cancel.is_cancelled() {
                return applied;
            }
            let id = format!("skill-selection-{index}");
            let outcome = self.skill_tool.call(&self.context(&id), json!({ "name": name })).await;
            let (summary, follow_ups) = match outcome {
                Ok(output) => (summary_of(&output.parts), output.follow_up_messages),
                Err(error) => (error.message_for_model, Vec::new()),
            };
            if loaded_skill(&summary) {
                applied.push(name);
            }
            transcript.push(AgentMessage::sourced(
                Source::SkillContext,
                format!("<system-reminder>\nExplicit skill selection result:\n{summary}\n</system-reminder>"),
            ));
            transcript.extend(follow_ups.into_iter().map(|m| AgentMessage::sourced(Source::Skill, m.text)));
        }
        applied
    }

    /// `appendSkillUpdateNotices(messages, cwd)`: every skill whose latest body the transcript holds is compared
    /// with what the Skill tool would deliver at the turn's folder now.
    async fn update_notices(&self, transcript: &[AgentMessage]) -> Vec<AgentMessage> {
        let Some(deliveries) = &self.deliveries else { return Vec::new() };
        let mut notices = Vec::new();
        for body in mixdog_agent::skill_update::latest_skill_bodies(transcript) {
            let delivery = match deliveries.delivery(&body.name, Path::new(self.env.cwd.as_path())).await {
                Ok(delivery) => delivery,
                // A catalog that cannot be read says nothing about the skill: no state is told this turn.
                Err(error) => {
                    tracing::warn!(%error, skill = %body.name, "the skill-update notice could not read the skill catalog");
                    continue;
                }
            };
            notices.extend(mixdog_agent::skill_update::skill_update_notice(transcript, &body, delivery.as_deref()));
        }
        notices
    }
}

/// `SkillsListed` over the skill catalog: whether any skill is visible at the folder
/// (`collectPromptSkillsCached(cwd).length`). Like Node it collects (cached; an invalidated list
/// is collected again) before it filters, so a cold start and a skill added since are both exact.
pub struct CatalogSkillsListed(pub Arc<SkillCatalog>);

#[async_trait]
impl SkillsListed for CatalogSkillsListed {
    async fn any_for(&self, cwd: &Path) -> Result<bool, String> {
        self.0.visible(cwd).await.map(|skills| !skills.is_empty()).map_err(|error| error.to_string())
    }
}

/// `ToolResolver` for the policy: a tool of the pool by name or alias, or an MCP tool by its
/// qualified name (`mcp__<server>__<tool>`) on a ready server of the calling session's scope, which a
/// pool alone cannot resolve (`isRegisteredMcpTool(name, sessionRef.mcpScopeId)`, `tool-exec/dispatch.mjs:57-59`).
/// A name neither knows resolves to nothing, and no other session's server is consulted.
pub struct McpAwareResolver {
    pool: Vec<Arc<dyn Tool>>,
    hub: Arc<McpHub>,
}

impl McpAwareResolver {
    /// `pool` is the same registry the session tool set is built from.
    pub fn new(pool: Vec<Arc<dyn Tool>>, hub: Arc<McpHub>) -> Self {
        Self { pool, hub }
    }
}

impl ToolResolver for McpAwareResolver {
    fn resolve(&self, scope: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
        let pooled = self.pool.iter().find(|tool| tool.spec().name == name || tool.spec().aliases.iter().any(|alias| alias == name));
        pooled.cloned().or_else(|| self.hub.tool_in(&normalize_scope(scope), name))
    }
}

/// The unattended run that owns a session (`unattendedApprovalPort().runOf`,
/// `session-runtime/held-requests.mjs` `unattendedRunOf`). Implemented by whoever tracks the
/// schedule, webhook and room runs.
#[async_trait]
pub trait UnattendedRuns: Send + Sync {
    async fn run_of(&self, thread: &ThreadId) -> Option<GateRun>;
}

/// `isContactAgentId(id, readAgentDefinitionKind(id))`: the agent store owns the definitions, and
/// every call reads the kind afresh, as Node's gate does.
#[async_trait]
pub trait ContactBots: Send + Sync {
    async fn is_contact_bot(&self, agent_id: &str) -> bool;
}

/// The Developer option "Allow all actions" (`developerOptionEnabledStrict('allowAllActions')`).
pub trait AllowAllActions: Send + Sync {
    fn allow_all_actions(&self) -> bool;
}

/// [`AllowAllActions`] over the config document: on only when `agent.developer.allowAllActions`
/// is `true`; absent or any other value is off.
pub struct ConfigAllowAll(pub Config);

impl AllowAllActions for ConfigAllowAll {
    fn allow_all_actions(&self) -> bool {
        developer_option_enabled("allowAllActions", self.0.agent().get("developer").unwrap_or(&JsonValue::Null))
    }
}

/// The real `GateEnv`: the session's unattended run, contact bots and the "Allow all actions"
/// option from their owners, and the connector account from the hub (`resolveMcpToolAccount`).
pub struct HostGateEnv {
    runs: Arc<dyn UnattendedRuns>,
    contacts: Arc<dyn ContactBots>,
    allow_all: Arc<dyn AllowAllActions>,
    hub: Arc<McpHub>,
}

impl HostGateEnv {
    pub fn new(runs: Arc<dyn UnattendedRuns>, contacts: Arc<dyn ContactBots>, allow_all: Arc<dyn AllowAllActions>, hub: Arc<McpHub>) -> Self {
        Self { runs, contacts, allow_all, hub }
    }
}

#[async_trait]
impl GateEnv for HostGateEnv {
    async fn run_of(&self, thread: &ThreadId) -> Option<GateRun> {
        self.runs.run_of(thread).await
    }

    async fn is_contact_bot(&self, agent_id: &str) -> bool {
        self.contacts.is_contact_bot(agent_id).await
    }

    fn allow_all_actions(&self) -> bool {
        self.allow_all.allow_all_actions()
    }

    /// The account `args.account` names, else the one the conversation (the thread) used last;
    /// the refusal when it cannot be used.
    async fn connector_account(&self, thread: &ThreadId, header: &Header, call: &GateCall) -> Result<Option<BoundAccount>, String> {
        // `resolveMcpToolAccount(name, args, { scopeId: ctx.mcpScopeId })`: the servers of the session's scope.
        let scope = normalize_scope(super::session_tools::header_scope(header));
        match self.hub.resolve_tool_account_in(&scope, &call.name, &call.args, thread.as_str()).await {
            Ok(chosen) => Ok(chosen.map(|account| BoundAccount { name: account.name, label: account.label })),
            Err(refusal) => Err(refusal.to_string()),
        }
    }
}
