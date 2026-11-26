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
use mixdog_ai::registry::providers::{OAUTH_PROVIDER_NAMES, ProviderRegistry};
use mixdog_ai::service::admin_route::{normalize_context_tokens, number, provider_switched_off, truthy};
use mixdog_ai::service::routes::canonical_route_provider;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_config::config::Config;
use mixdog_core_run::run_host::route_chain::{route_leaf, same_route_model};
use mixdog_core_session::session::dispatch_sessions::DispatchThreads;
use mixdog_store::schema::record::Header;
use serde_json::{Map, Value, json};

use crate::run_host::agent_dispatch::{AskRequest, DispatchSessions, PrepareSpec, Prepared};
use crate::run_host::agent_world::{RouteWindows, context_selection, resolve_runtime_spec};

/// The ACP agents a route's provider can name: a session on one runs its turns in that agent.
pub trait AgentRoutes: Send + Sync + 'static {
    /// `None`: `provider` is no agent's. `Some(Ok)`: the agent can run a session now; `Some(Err)`: the agent's own
    /// state message for why it cannot.
    fn admits(&self, provider: &str) -> Option<Result<(), String>>;
}

/// Admits the route provider `name` of a new session: an agent's when it is ready, else a registered provider.
/// The provider adapter is `None` on an agent's route.
pub fn admit_route(providers: &ProviderRegistry, agents: Option<&dyn AgentRoutes>, name: &str) -> Result<Option<Arc<dyn ProviderAdapter>>, String> {
    let canonical = canonical_route_provider(name);
    if let Some(admitted) = agents.and_then(|agents| agents.admits(name).or_else(|| (canonical != name).then(|| agents.admits(&canonical)).flatten())) {
        return admitted.map(|()| None);
    }
    providers
        .registered_for_route(&canonical)
        .or_else(|| (canonical != name).then(|| providers.registered_for_route(name)).flatten())
        .map(Some)
        .ok_or_else(|| format!("Provider \"{name}\" not found or not enabled"))
}

/// Async route admission that resolves ACP agents, already-registered HTTP adapters, cold usable OAuth providers
/// (`try_get`), and cold configured non-OAuth providers without force-enabling unconfigured or switched-off ones.
pub async fn admit_route_async(
    providers: &ProviderRegistry,
    agents: Option<&dyn AgentRoutes>,
    config: &Map<String, Value>,
    name: &str,
) -> Result<Option<Arc<dyn ProviderAdapter>>, String> {
    let canonical = canonical_route_provider(name);
    if let Some(admitted) = agents.and_then(|agents| agents.admits(name).or_else(|| (canonical != name).then(|| agents.admits(&canonical)).flatten())) {
        return admitted.map(|()| None);
    }
    if provider_switched_off(config, name) || (canonical != name && provider_switched_off(config, &canonical)) {
        return Err(format!("Provider \"{name}\" not found or not enabled"));
    }
    if let Some(adapter) = providers.try_get(&canonical).await.map_err(|error| error.message)? {
        return Ok(Some(adapter));
    }
    if !OAUTH_PROVIDER_NAMES.contains(&canonical.as_str())
        && let Some(configured) = config.get("providers").and_then(Value::as_object)
        && let Some(entry) = configured.get(name).or_else(|| configured.get(&canonical)).and_then(Value::as_object)
        && entry.get("enabled").and_then(Value::as_bool) != Some(false)
    {
        let mut enabled_entry = entry.clone();
        enabled_entry.insert("enabled".into(), Value::Bool(true));
        let mut single = Map::new();
        single.insert(canonical.clone(), Value::Object(enabled_entry));
        let _ = providers.init_providers(&single).await;
        if let Some(adapter) = providers.try_get(&canonical).await.map_err(|error| error.message)? {
            return Ok(Some(adapter));
        }
    }
    Err(format!("Provider \"{name}\" not found or not enabled"))
}

/// Recomputes `contextPercent`, `selectedContextWindow`, and `contextTokens` for a bound fallback preset
/// against the fallback model's window metadata, shared by child spawn and internal dispatch.
pub fn rebind_fallback_context(bound_preset: &Value, windows: &dyn RouteWindows) -> Map<String, Value> {
    if truthy(bound_preset.get("contextPercent")) || truthy(bound_preset.get("contextTokens")) { context_selection(bound_preset, windows) } else { Map::new() }
}

/// The admitted header and resolved HTTP adapter (`None` for an ACP agent route).
pub struct AdmittedHeader {
    pub header: Header,
    pub provider: Option<Arc<dyn ProviderAdapter>>,
}

/// Applies a fallback candidate's route fields onto `base`, keeping preset identity and fallback metadata.
pub fn apply_fallback_to_preset(base: &Value, candidate: &Value) -> Value {
    let mut out = base.as_object().cloned().unwrap_or_default();
    for key in
        ["provider", "model", "effort", "fast", "autoEffort", "modelParameters", "contextPercent", "contextTokens", "modelDisplay", "display", "displayName"]
    {
        out.shift_remove(key);
    }
    let text =
        |key: &str| candidate.get(key).filter(|value| truthy(Some(value))).map(|value| mixdog_js::js_trim(&mixdog_js::value_to_string(value)).to_owned());
    if let Some(provider) = text("provider").filter(|s| !s.is_empty()) {
        out.insert("provider".into(), Value::String(provider));
    }
    if let Some(model) = text("model").filter(|s| !s.is_empty()) {
        out.insert("model".into(), Value::String(model));
    }
    if let Some(effort) = text("effort").filter(|s| !s.is_empty()) {
        out.insert("effort".into(), Value::String(effort));
    }
    out.insert("fast".into(), Value::Bool(candidate.get("fast") == Some(&Value::Bool(true))));
    if candidate.get("autoEffort") == Some(&Value::Bool(false)) {
        out.insert("autoEffort".into(), Value::Bool(false));
    }
    if let Some(params) = candidate.get("modelParameters").filter(|value| value.is_object()) {
        out.insert("modelParameters".into(), params.clone());
    }
    for key in ["contextPercent", "contextTokens"] {
        if let Some(value) = candidate.get(key).filter(|value| truthy(Some(value))) {
            out.insert(key.into(), value.clone());
        }
    }
    Value::Object(out)
}

async fn is_exhausted(adapter: Option<&Arc<dyn ProviderAdapter>>, model: &str) -> bool {
    match adapter {
        Some(adapter) => adapter.quota_eligibility(model).await == Some(false),
        None => false,
    }
}

fn config_provider_model_window(config: &Map<String, Value>, raw_provider: &str, canonical_provider: &str, model: &str) -> Option<Value> {
    let providers = config.get("providers").and_then(Value::as_object)?;
    let entry = providers.get(raw_provider).or_else(|| providers.get(canonical_provider))?;
    let models = entry.get("models").and_then(Value::as_array)?;
    models
        .iter()
        .find(|row| {
            let id = row.get("id").and_then(Value::as_str).map(mixdog_js::js_trim).unwrap_or_default();
            (id == model || id.eq_ignore_ascii_case(model)) && (row.get("contextWindow").is_some() || row.get("maxContextWindow").is_some())
        })
        .cloned()
}

fn primary_fallback_leaf(spec: &PrepareSpec, config: &Map<String, Value>, primary_windows: &dyn RouteWindows) -> Map<String, Value> {
    let mut primary = route_leaf(Some(&spec.preset));
    if let Some(window) = normalize_context_tokens(spec.context.get("selectedContextWindow")) {
        primary.insert("selectedContextWindow".into(), mixdog_ai::service::admin_route::jnum(window));
        if let Some(tokens) = normalize_context_tokens(spec.context.get("contextTokens")) {
            primary.insert("contextTokens".into(), mixdog_ai::service::admin_route::jnum(tokens));
        } else {
            primary.shift_remove("contextTokens");
        }
        return primary;
    }
    if let Some(window) = normalize_context_tokens(spec.preset.get("selectedContextWindow")) {
        primary.insert("selectedContextWindow".into(), mixdog_ai::service::admin_route::jnum(window));
        return primary;
    }
    let resolved = context_selection(&spec.preset, primary_windows);
    if let Some(window) = normalize_context_tokens(resolved.get("selectedContextWindow")) {
        primary.insert("selectedContextWindow".into(), mixdog_ai::service::admin_route::jnum(window));
        if let Some(tokens) = normalize_context_tokens(resolved.get("contextTokens")) {
            primary.insert("contextTokens".into(), mixdog_ai::service::admin_route::jnum(tokens));
        } else if primary.contains_key("contextTokens") {
            primary.shift_remove("contextTokens");
        }
        return primary;
    }
    let raw_provider = spec.preset.get("provider").and_then(Value::as_str).map(mixdog_js::js_trim).unwrap_or_default();
    let canonical = canonical_route_provider(raw_provider);
    let model = spec.preset.get("model").and_then(Value::as_str).map(mixdog_js::js_trim).unwrap_or_default();
    if !canonical.is_empty()
        && !model.is_empty()
        && let Some(meta) = config_provider_model_window(config, raw_provider, &canonical, model)
        && let Some(route) = spec.preset.as_object()
    {
        let state = mixdog_ai::service::admin_route::resolve_route_context_state(route, Some(&meta));
        if let Some(window) = state.selected_context_window {
            primary.insert("selectedContextWindow".into(), mixdog_ai::service::admin_route::jnum(window));
            if let Some(tokens) = state.context_tokens {
                primary.insert("contextTokens".into(), mixdog_ai::service::admin_route::jnum(tokens));
            } else if primary.contains_key("contextTokens") {
                primary.shift_remove("contextTokens");
            }
        }
    }
    primary
}

fn stamp_fallback_choice(
    spec: &PrepareSpec,
    config: &Map<String, Value>,
    primary_windows: &dyn RouteWindows,
    candidate: &Value,
    index: usize,
    failures: Vec<Value>,
    on_fallback: &impl Fn(&Value, &PrepareSpec) -> (Map<String, Value>, Value),
) -> Result<Header, String> {
    let bound_preset = apply_fallback_to_preset(&spec.preset, candidate);
    let (context, runtime_spec) = on_fallback(&bound_preset, spec);
    let mut bound_spec = spec.clone();
    bound_spec.preset = bound_preset;
    bound_spec.context = context;
    bound_spec.runtime_spec = runtime_spec;
    let mut header = stamped_header(&bound_spec, |_| Ok(()))?;
    header.insert("routeFallbackPrimary".into(), Value::Object(primary_fallback_leaf(spec, config, primary_windows)));
    header.insert("routeFallbackIndex".into(), json!(index + 1));
    header.insert("routeFallbackFailures".into(), Value::Array(failures));
    Ok(header)
}

/// Resolves and admits the executable route across the primary and its configured fallback chain.
/// A strict explicit model pin carries no `fallbacks` and therefore fails immediately if the primary cannot be admitted.
pub async fn admit_stamped_header(
    spec: &PrepareSpec,
    providers: &ProviderRegistry,
    agents: Option<&dyn AgentRoutes>,
    config: &Map<String, Value>,
    on_fallback: impl Fn(&Value, &PrepareSpec) -> (Map<String, Value>, Value),
) -> Result<AdmittedHeader, String> {
    let provider_windows = ProviderWindows(providers);
    admit_stamped_header_with_windows(spec, providers, agents, config, &provider_windows, on_fallback).await
}

pub async fn admit_stamped_header_with_windows(
    spec: &PrepareSpec,
    providers: &ProviderRegistry,
    agents: Option<&dyn AgentRoutes>,
    config: &Map<String, Value>,
    primary_windows: &dyn RouteWindows,
    on_fallback: impl Fn(&Value, &PrepareSpec) -> (Map<String, Value>, Value),
) -> Result<AdmittedHeader, String> {
    let field = |key: &str| spec.preset.get(key).filter(|value| truthy(Some(value)));
    let Some(primary_provider_val) = field("provider") else { return Err("createSession: provider is required".into()) };
    let Some(primary_model_val) = field("model") else { return Err("createSession: model is required".into()) };
    let primary_provider = mixdog_js::value_to_string(primary_provider_val);
    let primary_model = mixdog_js::value_to_string(primary_model_val);
    let fallbacks: Vec<Value> = spec.preset.get("fallbacks").and_then(Value::as_array).cloned().unwrap_or_default();

    let mut failures: Vec<Value> = Vec::new();
    let mut primary_exhausted: Option<Option<Arc<dyn ProviderAdapter>>> = None;
    let mut primary_error: Option<String> = None;

    match admit_route_async(providers, agents, config, &primary_provider).await {
        Ok(adapter) => {
            if fallbacks.is_empty() || !is_exhausted(adapter.as_ref(), &primary_model).await {
                let header = stamped_header(spec, |_| Ok(()))?;
                return Ok(AdmittedHeader { header, provider: adapter });
            }
            failures.push(json!({
                "provider": primary_provider,
                "model": primary_model,
                "kind": "quota_exhausted",
                "error": "usage limit reached",
            }));
            primary_exhausted = Some(adapter);
        }
        Err(error) => {
            if fallbacks.is_empty() {
                return Err(error);
            }
            failures.push(json!({
                "provider": primary_provider,
                "model": primary_model,
                "kind": "provider_unavailable",
                "error": error,
            }));
            primary_error = Some(error);
        }
    }

    type ExhaustedCandidate = (usize, Value, Option<Arc<dyn ProviderAdapter>>, Vec<Value>);
    let mut first_exhausted: Option<ExhaustedCandidate> = None;
    for (idx, candidate) in fallbacks.iter().enumerate() {
        if !candidate.is_object() || same_route_model(Some(&spec.preset), Some(candidate)) {
            continue;
        }
        let Some(cand_provider) = candidate.get("provider").filter(|v| truthy(Some(v))).map(mixdog_js::value_to_string) else { continue };
        let Some(cand_model) = candidate.get("model").filter(|v| truthy(Some(v))).map(mixdog_js::value_to_string) else { continue };
        let cand_provider = mixdog_js::js_trim(&cand_provider).to_owned();
        let cand_model = mixdog_js::js_trim(&cand_model).to_owned();
        if cand_provider.is_empty() || cand_model.is_empty() {
            continue;
        }
        match admit_route_async(providers, agents, config, &cand_provider).await {
            Ok(adapter) => {
                if !is_exhausted(adapter.as_ref(), &cand_model).await {
                    let header = stamp_fallback_choice(spec, config, primary_windows, candidate, idx, failures, &on_fallback)?;
                    return Ok(AdmittedHeader { header, provider: adapter });
                }
                if first_exhausted.is_none() {
                    first_exhausted = Some((idx, candidate.clone(), adapter, failures.clone()));
                }
                failures.push(json!({
                    "provider": cand_provider,
                    "model": cand_model,
                    "kind": "quota_exhausted",
                    "error": "usage limit reached",
                }));
            }
            Err(error) => {
                failures.push(json!({
                    "provider": cand_provider,
                    "model": cand_model,
                    "kind": "provider_unavailable",
                    "error": error,
                }));
            }
        }
    }

    if let Some(adapter) = primary_exhausted {
        let header = stamped_header(spec, |_| Ok(()))?;
        return Ok(AdmittedHeader { header, provider: adapter });
    }
    if let Some((idx, candidate, adapter, saved_failures)) = first_exhausted {
        let header = stamp_fallback_choice(spec, config, primary_windows, &candidate, idx, saved_failures, &on_fallback)?;
        return Ok(AdmittedHeader { header, provider: adapter });
    }
    Err(primary_error.unwrap_or_else(|| format!("Provider \"{primary_provider}\" not found or not enabled")))
}

struct ProviderWindows<'a>(&'a ProviderRegistry);

impl RouteWindows for ProviderWindows<'_> {
    fn window_meta(&self, provider: &str, model: &str) -> Option<Value> {
        let canonical = canonical_route_provider(provider);
        for name in [provider, canonical.as_str()] {
            if let Some(row) = self.0.route_provider(name).and_then(|rp| rp.cached).and_then(|c| c.cached_row(model)) {
                return Some((*row).clone());
            }
        }
        mixdog_ai::catalog::guess_context_window(model, &canonical).map(|cap| json!({ "contextWindow": cap, "maxContextWindow": cap }))
    }
}

pub struct SessionDispatch {
    threads: Arc<DispatchThreads>,
    providers: Arc<ProviderRegistry>,
    agents: Option<Arc<dyn AgentRoutes>>,
    /// The saved configuration: the `autoClear` a session's cache policy follows.
    config: Config,
    /// Optional catalog window lookup for fallback context-window rebinding.
    windows: Option<Arc<dyn RouteWindows>>,
}

impl SessionDispatch {
    /// `providers`: the process's provider registry (`getProvider`); `agents`: the ACP agents a route can name;
    /// `config`: the saved configuration.
    pub fn new(threads: Arc<DispatchThreads>, providers: Arc<ProviderRegistry>, agents: Option<Arc<dyn AgentRoutes>>, config: Config) -> Self {
        Self { threads, providers, agents, config, windows: None }
    }

    pub fn with_windows(mut self, windows: Arc<dyn RouteWindows>) -> Self {
        self.windows = Some(windows);
        self
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
        let config = self.config.agent();
        let provider_windows = ProviderWindows(&self.providers);
        let windows: &dyn RouteWindows = self.windows.as_deref().unwrap_or(&provider_windows);
        let AdmittedHeader { mut header, provider } =
            admit_stamped_header_with_windows(&spec, &self.providers, self.agents.as_deref(), &config, windows, |bound_preset, spec| {
                (rebind_fallback_context(bound_preset, windows), resolve_runtime_spec(bound_preset, &spec.agent))
            })
            .await?;
        super::session_cache_opts::stamp_cache_opts(&mut header, &config.get("autoClear").cloned().unwrap_or(Value::Null));
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

    /// OAuth provider whose credentials are usable on demand, with no eager registration.
    struct ColdOAuth {
        usable: &'static str,
    }

    #[async_trait]
    impl ProviderBuilder for ColdOAuth {
        async fn build(&self, _: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            Ok(Arc::new(MockProvider::new([])))
        }
        async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, name: &str) -> Result<bool, String> {
            Ok(name == self.usable)
        }
    }

    #[tokio::test]
    async fn unavailable_primary_with_healthy_fallback_lands_on_fallback_while_strict_pin_refuses() {
        let registry = ProviderRegistry::new(Arc::new(Mocks));
        let stored = json!({ "anthropic": { "enabled": true } }).as_object().unwrap().clone();
        registry.init_providers(&stored).await.unwrap();
        let config = Map::new();

        // Unavailable primary (`openai`) with healthy configured fallback (`anthropic`) lands on fallback.
        let mut with_fallback = spec_of(
            "worker",
            json!({
                "id": "agent-worker",
                "name": "AGENT WORKER",
                "provider": "openai",
                "model": "gpt-5",
                "effort": "high",
                "fast": true,
                "fallbacks": [{ "provider": "anthropic", "model": "sonnet-4", "effort": "low", "fast": false }],
                "fallbackSource": { "agent": "worker" }
            }),
        );
        with_fallback.runtime_spec = resolve_runtime_spec(&with_fallback.preset, "worker-1");
        let admitted = admit_stamped_header(&with_fallback, &registry, None, &config, |bound, _| (Map::new(), resolve_runtime_spec(bound, "worker-1")))
            .await
            .expect("should land on healthy fallback");
        assert_eq!(admitted.header["provider"], json!("anthropic"));
        assert_eq!(admitted.header["model"], json!("sonnet-4"));
        assert_eq!(admitted.header["effort"], json!("low"));
        assert_eq!(admitted.header["fast"], json!(false));
        assert_eq!(admitted.header["presetName"], json!("AGENT WORKER"));
        assert_eq!(admitted.header["routeFallbackIndex"], json!(1));
        assert_eq!(admitted.header["routeFallbackPrimary"]["provider"], json!("openai"));
        assert_eq!(admitted.header["routeFallbackPrimary"]["model"], json!("gpt-5"));
        assert_eq!(admitted.header["routeFallbackPrimary"]["effort"], json!("high"));
        assert_eq!(admitted.header["routeFallbackFailures"].as_array().map(Vec::len), Some(1));
        assert_eq!(admitted.header["scopeKey"], json!("agent:worker-1:anthropic:sonnet-4"));

        // Strict explicit model pin carries no `fallbacks` and must still refuse when primary is unavailable.
        let strict_pin = spec_of(
            "worker",
            json!({
                "id": "__direct__",
                "name": "__DIRECT__",
                "provider": "openai",
                "model": "gpt-5"
            }),
        );
        let err = admit_stamped_header(&strict_pin, &registry, None, &config, |bound, _| (Map::new(), resolve_runtime_spec(bound, "worker-1"))).await.err();
        assert_eq!(err.as_deref(), Some("Provider \"openai\" not found or not enabled"));
    }

    #[tokio::test]
    async fn cold_usable_oauth_primary_is_lazily_admitted_and_cold_configured_provider_initializes() {
        let oauth_registry = ProviderRegistry::new(Arc::new(ColdOAuth { usable: "openai-oauth" }));
        let spec = spec_of("worker", json!({ "provider": "openai-oauth", "model": "gpt-5" }));
        let admitted = admit_stamped_header(&spec, &oauth_registry, None, &Map::new(), |bound, _| (Map::new(), resolve_runtime_spec(bound, "worker")))
            .await
            .expect("cold usable OAuth primary should be lazily built and admitted");
        assert_eq!(admitted.header["provider"], json!("openai-oauth"));
        assert!(admitted.provider.is_some());

        let api_registry = ProviderRegistry::new(Arc::new(Mocks));
        let config = json!({ "providers": { "openai": { "enabled": true } } }).as_object().unwrap().clone();
        let api_spec = spec_of("worker", json!({ "provider": "openai", "model": "gpt-5" }));
        let admitted = admit_stamped_header(&api_spec, &api_registry, None, &config, |bound, _| (Map::new(), resolve_runtime_spec(bound, "worker")))
            .await
            .expect("cold configured non-OAuth provider should initialize lazily");
        assert_eq!(admitted.header["provider"], json!("openai"));
    }

    #[tokio::test]
    async fn provider_alias_openai_api_is_admitted_when_openai_is_usable() {
        let registered = ProviderRegistry::new(Arc::new(Mocks));
        let stored = json!({ "openai": { "enabled": true } }).as_object().unwrap().clone();
        registered.init_providers(&stored).await.unwrap();
        assert!(admit_route(&registered, None, "openai-api").is_ok(), "sync admit_route must canonicalize openai-api -> openai");
        let admitted = admit_route_async(&registered, None, &Map::new(), "openai-api").await.expect("async admit_route_async must admit openai-api");
        assert!(admitted.is_some());

        let cold = ProviderRegistry::new(Arc::new(Mocks));
        let config = json!({ "providers": { "openai": { "enabled": true } } }).as_object().unwrap().clone();
        let spec = spec_of("worker", json!({ "provider": "openai-api", "model": "gpt-5" }));
        let admitted = admit_stamped_header(&spec, &cold, None, &config, |bound, _| (Map::new(), resolve_runtime_spec(bound, "worker")))
            .await
            .expect("cold configured openai must be lazily admitted via openai-api alias");
        assert_eq!(admitted.header["provider"], json!("openai-api"));
        assert!(admitted.provider.is_some());
    }

    struct FixedWindows(u64);
    impl RouteWindows for FixedWindows {
        fn window_meta(&self, provider: &str, model: &str) -> Option<Value> {
            (provider == "anthropic" && model == "sonnet-4").then(|| json!({ "contextWindow": self.0, "maxContextWindow": self.0 }))
        }
    }

    struct NoRelease;
    impl mixdog_core_session::session::agent_registry::RuntimeRelease for NoRelease {
        fn release(&self, _: &mixdog_core_api::ids::ThreadId, _: &str) {}
    }

    struct NoShells;
    impl mixdog_core_session::session::shell_jobs::OwnedShells for NoShells {
        fn cancel_owned(&self, _: &mixdog_core_api::ids::ThreadId) {}
    }

    struct CachedMocks(u64);
    struct CachedRow(u64);
    impl mixdog_ai::catalog::CachedModelInfo for CachedRow {
        fn cached_row(&self, model: &str) -> Option<Arc<Value>> {
            (model == "sonnet-4").then(|| Arc::new(json!({ "id": "sonnet-4", "contextWindow": self.0, "maxContextWindow": self.0 })))
        }
    }

    #[async_trait]
    impl ProviderBuilder for CachedMocks {
        async fn build(&self, _: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            Ok(Arc::new(MockProvider::new([])))
        }
        fn cached_model_info(&self, name: &str) -> Option<Arc<dyn mixdog_ai::catalog::CachedModelInfo>> {
            (name == "anthropic").then(|| Arc::new(CachedRow(self.0)) as Arc<dyn mixdog_ai::catalog::CachedModelInfo>)
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

    #[tokio::test]
    async fn session_dispatch_prepare_rebinds_selected_context_window_on_fallback() {
        let rig = mixdog_core_session::session::testing::Rig::new();
        let directory = Arc::new(mixdog_core_session::session::SessionDirectory::new(rig.deps()));
        let providers = Arc::new(ProviderRegistry::new(Arc::new(CachedMocks(200_000))));
        let stored = json!({ "anthropic": { "enabled": true } }).as_object().unwrap().clone();
        providers.init_providers(&stored).await.unwrap();
        let turns = Arc::new(mixdog_core_session::session::agent_registry::SessionTurns::new(directory.clone(), Arc::new(NoRelease)));
        let close = Arc::new(mixdog_core_session::session::close::SessionClose::new(
            directory.clone(),
            providers.clone(),
            Arc::new(NoShells),
            Arc::new(mixdog_tools::fs::ReadState::new(None)),
        ));
        let threads = Arc::new(DispatchThreads::new(directory.clone(), turns, close, None));
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let lanes = mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (config, _) =
            Config::open(dir.path().join("mixdog-config.json"), Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.unwrap();

        // Production `SessionDispatch::new` (ProviderWindows) resolves fallback `selectedContextWindow` from cached rows.
        let dispatch = SessionDispatch::new(threads.clone(), providers.clone(), None, config.clone());
        let spec_pct = spec_of(
            "worker",
            json!({
                "provider": "openai",
                "model": "gpt-5",
                "fallbacks": [{ "provider": "anthropic", "model": "sonnet-4", "contextPercent": 50 }]
            }),
        );
        let prepared = dispatch.prepare(spec_pct).await.expect("prepare should fall back to anthropic");
        let header = directory.stored_header(&mixdog_core_api::ids::ThreadId::from(prepared.id.as_str())).await.expect("created header");
        assert_eq!(header["provider"], json!("anthropic"));
        assert_eq!(header["model"], json!("sonnet-4"));
        assert_eq!(header["contextPercent"], json!(50));
        assert_eq!(header["selectedContextWindow"], json!(100_000));

        // Attached `RouteWindows` (e.g. CatalogWindows) also computes reduced `selectedContextWindow` on fallback.
        let dispatch_with_windows = SessionDispatch::new(threads, providers, None, config).with_windows(Arc::new(FixedWindows(200_000)));
        let spec_tokens = spec_of(
            "worker",
            json!({
                "provider": "openai",
                "model": "gpt-5",
                "fallbacks": [{ "provider": "anthropic", "model": "sonnet-4", "contextTokens": 128_000 }]
            }),
        );
        let prepared_tokens = dispatch_with_windows.prepare(spec_tokens).await.expect("prepare with explicit windows");
        let header_tokens =
            directory.stored_header(&mixdog_core_api::ids::ThreadId::from(prepared_tokens.id.as_str())).await.expect("created header with tokens");
        assert_eq!(header_tokens["provider"], json!("anthropic"));
        assert_eq!(header_tokens["contextTokens"], json!(128_000));
        assert_eq!(header_tokens["selectedContextWindow"], json!(128_000));
    }

    struct CatalogOnlyPrimaryWindows;
    impl RouteWindows for CatalogOnlyPrimaryWindows {
        fn window_meta(&self, provider: &str, model: &str) -> Option<Value> {
            (provider == "acme-catalog" && model == "acme-reasoner-200k").then(|| json!({ "contextWindow": 200_000, "maxContextWindow": 200_000 }))
        }
    }

    #[tokio::test]
    async fn upfront_fallback_preserves_authoritative_selected_context_window_on_route_fallback_primary() {
        let registry = ProviderRegistry::new(Arc::new(Mocks));
        let stored = json!({ "anthropic": { "enabled": true } }).as_object().unwrap().clone();
        registry.init_providers(&stored).await.unwrap();
        let config = Map::new();

        // Case 1: spawn resolved a catalog-only 200k default into `spec.context` (omitting default `contextTokens`).
        let mut with_default_window = spec_of(
            "worker",
            json!({
                "provider": "acme-catalog",
                "model": "acme-reasoner-200k",
                "effort": "high",
                "contextTokens": 200_000,
                "fallbacks": [{ "provider": "anthropic", "model": "sonnet-4" }]
            }),
        );
        with_default_window.context.insert("contextPercent".into(), json!(100));
        with_default_window.context.insert("selectedContextWindow".into(), json!(200_000));
        let admitted = admit_stamped_header(&with_default_window, &registry, None, &config, |bound, _| (Map::new(), resolve_runtime_spec(bound, "worker")))
            .await
            .expect("should land on fallback");
        assert_eq!(admitted.header["routeFallbackPrimary"]["selectedContextWindow"], json!(200_000));
        assert!(
            admitted.header["routeFallbackPrimary"].get("contextTokens").is_none(),
            "redundant default contextTokens should match runtime-hop normalization"
        );

        // Case 2: explicit reduced cap (100k) preserves both `contextTokens` and `selectedContextWindow`.
        let mut with_cap = spec_of(
            "worker",
            json!({
                "provider": "acme-catalog",
                "model": "acme-reasoner-200k",
                "contextTokens": 100_000,
                "fallbacks": [{ "provider": "anthropic", "model": "sonnet-4" }]
            }),
        );
        with_cap.context.insert("contextPercent".into(), json!(50));
        with_cap.context.insert("contextTokens".into(), json!(100_000));
        with_cap.context.insert("selectedContextWindow".into(), json!(100_000));
        let admitted_cap = admit_stamped_header(&with_cap, &registry, None, &config, |bound, _| (Map::new(), resolve_runtime_spec(bound, "worker")))
            .await
            .expect("should land on fallback with reduced cap");
        assert_eq!(admitted_cap.header["routeFallbackPrimary"]["contextTokens"], json!(100_000));
        assert_eq!(admitted_cap.header["routeFallbackPrimary"]["selectedContextWindow"], json!(100_000));

        // Case 3: `SessionDispatch::prepare` with catalog windows resolves primary `selectedContextWindow` even when `spec.context` is empty.
        let rig = mixdog_core_session::session::testing::Rig::new();
        let directory = Arc::new(mixdog_core_session::session::SessionDirectory::new(rig.deps()));
        let providers = Arc::new(ProviderRegistry::new(Arc::new(Mocks)));
        providers.init_providers(&stored).await.unwrap();
        let turns = Arc::new(mixdog_core_session::session::agent_registry::SessionTurns::new(directory.clone(), Arc::new(NoRelease)));
        let close = Arc::new(mixdog_core_session::session::close::SessionClose::new(
            directory.clone(),
            providers.clone(),
            Arc::new(NoShells),
            Arc::new(mixdog_tools::fs::ReadState::new(None)),
        ));
        let threads = Arc::new(DispatchThreads::new(directory.clone(), turns, close, None));
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let lanes = mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (cfg, _) =
            Config::open(dir.path().join("mixdog-config.json"), Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.unwrap();
        let dispatch = SessionDispatch::new(threads, providers, None, cfg).with_windows(Arc::new(CatalogOnlyPrimaryWindows));
        let plain_catalog_spec = spec_of(
            "worker",
            json!({
                "provider": "acme-catalog",
                "model": "acme-reasoner-200k",
                "fallbacks": [{ "provider": "anthropic", "model": "sonnet-4" }]
            }),
        );
        let prepared = dispatch.prepare(plain_catalog_spec).await.expect("prepare should land on fallback");
        let header = directory.stored_header(&mixdog_core_api::ids::ThreadId::from(prepared.id.as_str())).await.expect("created header");
        assert_eq!(header["routeFallbackPrimary"]["provider"], json!("acme-catalog"));
        assert_eq!(header["routeFallbackPrimary"]["model"], json!("acme-reasoner-200k"));
        assert_eq!(header["routeFallbackPrimary"]["selectedContextWindow"], json!(200_000));
    }
}
