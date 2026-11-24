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
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_config::config::Config;
use mixdog_core_session::session::dispatch_sessions::DispatchThreads;
use mixdog_store::schema::record::Header;
use serde_json::{Map, Value, json};

use crate::run_host::agent_dispatch::{AskRequest, DispatchSessions, PrepareSpec, Prepared};

/// The ACP agents a route's provider can name: a session on one runs its turns in that agent.
pub trait AgentRoutes: Send + Sync + 'static {
    /// `None`: `provider` is no agent's. `Some(Ok)`: the agent can run a session now; `Some(Err)`: the agent's own
    /// state message for why it cannot.
    fn admits(&self, provider: &str) -> Option<Result<(), String>>;
}

/// Admits the route provider `name` of a new session: an agent's when it is ready, else a registered provider.
/// The provider adapter is `None` on an agent's route.
pub fn admit_route(providers: &ProviderRegistry, agents: Option<&dyn AgentRoutes>, name: &str) -> Result<Option<Arc<dyn ProviderAdapter>>, String> {
    if let Some(admitted) = agents.and_then(|agents| agents.admits(name)) {
        return admitted.map(|()| None);
    }
    providers.registered_for_route(name).map(Some).ok_or_else(|| format!("Provider \"{name}\" not found or not enabled"))
}

pub struct SessionDispatch {
    threads: Arc<DispatchThreads>,
    providers: Arc<ProviderRegistry>,
    agents: Option<Arc<dyn AgentRoutes>>,
    /// The saved configuration: the `autoClear` a session's cache policy follows.
    config: Config,
}

impl SessionDispatch {
    /// `providers`: the process's provider registry (`getProvider`); `agents`: the ACP agents a route can name;
    /// `config`: the saved configuration.
    pub fn new(threads: Arc<DispatchThreads>, providers: Arc<ProviderRegistry>, agents: Option<Arc<dyn AgentRoutes>>, config: Config) -> Self {
        Self { threads, providers, agents, config }
    }
}

/// `normalizeContextPercent`: a requested share snapped to 10% steps within 10..100.
fn context_percent(value: Option<&Value>) -> Value {
    let requested = number(value);
    if requested.is_finite() && requested > 0.0 { json!(((requested / 10.0 + 0.5).floor() * 10.0).clamp(10.0, 100.0) as i64) } else { Value::Null }
}

fn text_or_null(value: Option<&String>) -> Value {
    value.filter(|text| !text.is_empty()).map_or(Value::Null, |text| json!(text))
}

/// What `prepareAgentSession(spec)` records on the new session (the record's route, provenance
/// and permission fields), or the error `createSession` throws.
pub fn stamped_header(spec: &PrepareSpec, admit: impl FnOnce(&str) -> Result<(), String>) -> Result<Header, String> {
    let preset = &spec.preset;
    let field = |key: &str| preset.get(key).filter(|value| truthy(Some(value)));
    let Some(provider) = field("provider") else { return Err("createSession: provider is required".into()) };
    let Some(model) = field("model") else { return Err("createSession: model is required".into()) };
    let provider = mixdog_js::value_to_string(provider);
    admit(&provider)?;
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
    if let Some(fallbacks) = preset.get("fallbacks") {
        header.insert("routeFallbacks".into(), fallbacks.clone());
    }
    Ok(header)
}

#[async_trait]
impl DispatchSessions for SessionDispatch {
    async fn prepare(&self, spec: PrepareSpec) -> Result<Prepared, String> {
        let mut provider = None;
        let mut header = stamped_header(&spec, |name| {
            provider = admit_route(&self.providers, self.agents.as_deref(), name)?;
            Ok(())
        })?;
        super::session_cache_opts::stamp_cache_opts(&mut header, &self.config.agent().get("autoClear").cloned().unwrap_or(Value::Null));
        // The MCP scope of the session that asked for the run (`mcpScopeId` of the spawning runtime).
        if let Some(parent) = spec.parent_session_id.as_deref().filter(|parent| !parent.is_empty())
            && let Some(scope) = self.threads.mcp_scope_of(parent).await
        {
            header.insert("mcpScopeId".into(), json!(scope));
        }
        // The first-response window the session's provider declares for its model: what the watchdog's first-response
        // deadlines sit above (`provider.firstResponseBudget(model, { modelParameters })`).
        let first_response_budget = provider
            .zip(header.get("model").and_then(Value::as_str))
            .and_then(|(provider, model)| provider.first_response_budget(model, header.get("modelParameters").filter(|parameters| parameters.is_object())));
        let id = self.threads.create(header).await?;
        Ok(Prepared { tools: self.threads.tools(&id), id, first_response_budget })
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

#[cfg(test)]
mod tests {
    use mixdog_ai::registry::providers::ProviderBuilder;
    use mixdog_core_api::domain::mock::MockProvider;
    use mixdog_core_api::domain::provider::ProviderAdapter;

    use super::*;

    /// Builds a scripted provider for any enabled name.
    struct Mocks;

    #[async_trait]
    impl ProviderBuilder for Mocks {
        async fn build(&self, _: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            Ok(Arc::new(MockProvider::new([])))
        }
        async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
            Ok(false)
        }
    }

    /// The header `prepare` stamps for a session on `provider`'s route, admitted as `prepare` admits it.
    fn session_on(registry: &ProviderRegistry, provider: &str) -> Result<Header, String> {
        session_with_agents(registry, None, provider)
    }

    /// The same, with `agents` the ACP agents a route can name.
    fn session_with_agents(registry: &ProviderRegistry, agents: Option<&dyn AgentRoutes>, provider: &str) -> Result<Header, String> {
        let spec = spec_of("worker", json!({"provider": provider, "model": "m"}));
        stamped_header(&spec, |name| admit_route(registry, agents, name).map(|_| ()))
    }

    fn spec_of(agent: &str, preset: Value) -> PrepareSpec {
        PrepareSpec {
            agent: agent.into(),
            preset_name: "p".into(),
            preset,
            runtime_spec: json!({}),
            context: Map::new(),
            permission: None,
            cwd: None,
            source_type: None,
            source_name: None,
            task_type: None,
            parent_session_id: None,
            owner_session_id: None,
            skip_role_reminder: false,
            schema_allowed_tools: None,
        }
    }

    /// One agent, `acp-agent`, ready or refusing with `state`.
    struct Agent(Result<(), String>);

    impl AgentRoutes for Agent {
        fn admits(&self, provider: &str) -> Option<Result<(), String>> {
            (provider == "acp-agent").then(|| self.0.clone())
        }
    }

    #[test]
    fn a_presets_fallback_chain_is_stamped_on_the_session() {
        let chain = json!([{ "provider": "anthropic", "model": "opus" }]);
        let spec = spec_of("explore", json!({"provider": "openai", "model": "m", "fallbacks": chain}));
        let header = stamped_header(&spec, |_| Ok(())).expect("admitted");
        assert_eq!(header["routeFallbacks"], chain);
    }

    #[test]
    fn a_session_on_a_ready_agents_route_is_admitted() {
        let registry = ProviderRegistry::new(Arc::new(Mocks));
        let header = session_with_agents(&registry, Some(&Agent(Ok(()))), "acp-agent").expect("admitted");
        assert_eq!(header["provider"], json!("acp-agent"));
    }

    #[test]
    fn a_session_on_an_unready_agents_route_is_refused_with_the_agents_state() {
        let registry = ProviderRegistry::new(Arc::new(Mocks));
        let agent = Agent(Err("ACP agents are turned off in Settings.".into()));
        assert_eq!(session_with_agents(&registry, Some(&agent), "acp-agent").err().as_deref(), Some("ACP agents are turned off in Settings."));
        assert_eq!(session_with_agents(&registry, Some(&agent), "other").err().as_deref(), Some("Provider \"other\" not found or not enabled"));
    }

    /// A provider is turned off and the removal settles; it is turned on again, and a session starts on its route
    /// with nothing but the sync of that decision in between.
    #[tokio::test]
    async fn a_session_starts_on_the_route_of_a_provider_turned_off_and_on_again() {
        let registry = ProviderRegistry::new(Arc::new(Mocks));
        let stored = |enabled: bool| json!({"anthropic": {"enabled": enabled}}).as_object().expect("object").clone();
        registry.init_providers(&stored(true)).await.expect("init");
        registry.sync_providers(&stored(false), Some(stored(false))).await.expect("off");
        assert_eq!(session_on(&registry, "anthropic").err().as_deref(), Some("Provider \"anthropic\" not found or not enabled"));
        registry.sync_providers(&stored(true), Some(stored(true))).await.expect("on");
        assert_eq!(session_on(&registry, "anthropic").expect("a session on the route")["provider"], json!("anthropic"));
    }
}
