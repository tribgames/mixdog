//! The production [`DispatchSessions`] of the agent dispatch (`agent_dispatch::HiddenRoleRunner`):
//! `prepareAgentSession(spec)` stamps the ephemeral session's header as Node's `createSession`
//! records it (`session-builder.mjs`, `session-lifecycle.mjs` `resolveSessionRoute`,
//! `session-record.mjs` `buildSessionRecord`/`sessionOriginFields`, golden
//! `fixtures/dispatch-sessions`) and creates it; the rest is the session layer's
//! [`DispatchThreads`], which creates it with the tool surface and prompt identity of an agent-owned
//! session (`NewThreadTools::seed_agent`). The prompt, context window and cache fields Node also puts
//! on the record are derived by the run host from this header at the turn.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::flow::seams::AssistantText;
use mixdog_agent::agent_tool::progress::Snapshot;
use mixdog_agent::cancel::Cancel;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::admin_route::{normalize_context_tokens, number, truthy};
use mixdog_core_session::session::dispatch_sessions::DispatchThreads;
use mixdog_store::schema::record::Header;
use serde_json::{Map, Value, json};

use crate::run_host::agent_dispatch::{AskRequest, DispatchSessions, PrepareSpec, Prepared};

pub struct SessionDispatch {
    threads: Arc<DispatchThreads>,
    providers: Arc<ProviderRegistry>,
}

impl SessionDispatch {
    /// `providers`: the process's provider registry (`getProvider`).
    pub fn new(threads: Arc<DispatchThreads>, providers: Arc<ProviderRegistry>) -> Self {
        Self { threads, providers }
    }
}

/// `normalizeContextPercent`: a requested share snapped to 10% steps within 10..100.
fn context_percent(value: Option<&Value>) -> Value {
    let requested = number(value);
    if requested.is_finite() && requested > 0.0 {
        json!(((requested / 10.0 + 0.5).floor() * 10.0).clamp(10.0, 100.0) as i64)
    } else {
        Value::Null
    }
}

fn text_or_null(value: Option<&String>) -> Value {
    value.filter(|text| !text.is_empty()).map_or(Value::Null, |text| json!(text))
}

/// What `prepareAgentSession(spec)` records on the new session (the record's route, provenance
/// and permission fields), or the error `createSession` throws. `registered`: `getProvider(name)`.
pub fn stamped_header(spec: &PrepareSpec, registered: impl Fn(&str) -> bool) -> Result<Header, String> {
    let preset = &spec.preset;
    let field = |key: &str| preset.get(key).filter(|value| truthy(Some(value)));
    let Some(provider) = field("provider") else { return Err("createSession: provider is required".into()) };
    let Some(model) = field("model") else { return Err("createSession: model is required".into()) };
    let provider = mixdog_js::value_to_string(provider);
    if !registered(&provider) {
        return Err(format!("Provider \"{provider}\" not found or not enabled"));
    }
    let context = |key: &str| spec.context.get(key);
    let permission = text_or_null(spec.permission.as_ref());
    let mut header = Map::new();
    header.insert("provider".into(), json!(provider));
    header.insert("model".into(), model.clone());
    // `opts.tools || presetObj.tools || 'full'`.
    header.insert("preset".into(), field("tools").cloned().unwrap_or_else(|| json!("full")));
    header.insert("presetName".into(), field("name").cloned().unwrap_or(Value::Null));
    header.insert("effort".into(), field("effort").cloned().unwrap_or(Value::Null));
    header.insert("fast".into(), json!(preset.get("fast") == Some(&Value::Bool(true))));
    // Absent means Auto effort is on; only the off state is recorded.
    if preset.get("autoEffort") == Some(&Value::Bool(false)) {
        header.insert("autoEffort".into(), json!(false));
    }
    header.insert("modelParameters".into(), preset.get("modelParameters").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({})));
    header.insert("contextPercent".into(), context_percent(context("contextPercent")));
    if let Some(tokens) = normalize_context_tokens(context("contextTokens")) {
        header.insert("contextTokens".into(), json!(tokens as i64));
    }
    header.insert("selectedContextWindow".into(), context("selectedContextWindow").filter(|value| truthy(Some(value))).cloned().unwrap_or(Value::Null));
    header.insert("agent".into(), json!(spec.agent));
    header.insert("owner".into(), json!("agent"));
    // An agent-owned session runs in coding mode (`resolveSessionMode`).
    header.insert("sessionMode".into(), json!("coding"));
    header.insert("callerDisallowedTools".into(), json!([]));
    header.insert("mcpScopeId".into(), Value::Null);
    header.insert("scopeKey".into(), spec.runtime_spec.get("scopeKey").filter(|value| truthy(Some(value))).cloned().unwrap_or(Value::Null));
    header.insert("lane".into(), spec.runtime_spec.get("lane").filter(|value| truthy(Some(value))).cloned().unwrap_or_else(|| json!("agent")));
    header.insert("cwd".into(), spec.cwd.as_ref().map_or(Value::Null, |cwd| json!(cwd)));
    header.insert("taskType".into(), text_or_null(spec.task_type.as_ref()));
    header.insert("agentTag".into(), Value::Null);
    header.insert("permission".into(), permission.clone());
    header.insert("toolPermission".into(), permission);
    header.insert("schemaAllowedTools".into(), spec.schema_allowed_tools.as_ref().map_or(Value::Null, |tools| json!(tools)));
    header.insert("sourceType".into(), text_or_null(spec.source_type.as_ref()));
    header.insert("sourceName".into(), text_or_null(spec.source_name.as_ref()));
    header.insert("permissionMode".into(), Value::Null);
    header.insert("parentSessionId".into(), text_or_null(spec.parent_session_id.as_ref()));
    header.insert("ownerSessionId".into(), text_or_null(spec.owner_session_id.as_ref()));
    header.insert("visibility".into(), Value::Null);
    header.insert("clientHostPid".into(), Value::Null);
    header.insert("closed".into(), json!(false));
    Ok(header)
}

#[async_trait]
impl DispatchSessions for SessionDispatch {
    async fn prepare(&self, spec: PrepareSpec) -> Result<Prepared, String> {
        let mut header = stamped_header(&spec, |name| self.providers.registered(name).is_some())?;
        // The MCP scope of the session that asked for the run (`mcpScopeId` of the spawning runtime).
        if let Some(parent) = spec.parent_session_id.as_deref().filter(|parent| !parent.is_empty())
            && let Some(scope) = self.threads.mcp_scope_of(parent).await
        {
            header.insert("mcpScopeId".into(), json!(scope));
        }
        let id = self.threads.create(header).await?;
        Ok(Prepared { tools: self.threads.tools(&id), id })
    }

    async fn set_status(&self, id: &str, status: &str) {
        self.threads.set_status(id, status).await;
    }

    async fn message_count(&self, id: &str) -> usize {
        self.threads.message_count(id).await
    }

    async fn assistant_texts(&self, id: &str, start: usize) -> Vec<AssistantText> {
        self.threads.assistant_texts(id, start).await
    }

    /// `liveProjection` is never set by a dispatch (no live-text observer): nothing to forward.
    async fn ask(&self, id: &str, request: AskRequest, cancel: &Cancel) -> Result<String, String> {
        self.threads.ask(id, &request.prompt, request.cwd, request.slot, cancel).await
    }

    fn progress(&self, id: &str, now: i64) -> Option<Snapshot> {
        self.threads.progress(id, now)
    }

    fn last_iteration_index(&self, id: &str) -> Option<Value> {
        self.threads.last_iteration_index(id)
    }

    fn arm_turn_timeout(&self, id: &str) {
        self.threads.arm_turn_timeout(id);
    }

    async fn close(&self, id: &str, reason: &str) {
        self.threads.close(id, reason).await;
    }
}
