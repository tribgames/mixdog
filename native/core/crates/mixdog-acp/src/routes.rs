//! A route on an agent, for every reader of a route: the agent is no provider of the catalog or the registry, so what
//! those readers ask of a route's provider is answered here for an agent's route.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::model_select::{ListOptions, ModelCatalog, ModelRow};
use mixdog_ai::service::routes::{
    DefaultSearchFallback, DefaultSearchRoute, is_web_search_capable_provider, pick_quick_web_search_model, web_search_capable_for,
};
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_domains::domains::ai_account::collaborators::WebSearchModels;
use mixdog_core_domains::domains::ai_account::failure::Failure;
use mixdog_core_domains::domains::ai_admin::chain::RouteFacts;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::route_facts::AgentAnswer;
use mixdog_core_ports::ports::route_facts::AgentAsk;
use mixdog_core_ports::ports::route_facts::RouteSender;
use mixdog_core_ports::ports::route_write::RouteWriter;
use mixdog_protocol::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;

use crate::agents::Agents;
use crate::preset::AgentPreset;

fn is_own_orchestration(preset: &AgentPreset, model: &str) -> bool {
    preset.quirks.own_orchestration.iter().any(|prefix| model.starts_with(prefix.as_str()))
}

fn preset_search_capable(preset: &AgentPreset) -> bool {
    !matches!(preset.own_tools_off, Some(crate::preset::OwnToolsOff::AgentFile(_))) && is_web_search_capable_provider(&preset.provider)
}

fn model_web_search_capable(agents: &Agents, preset: &AgentPreset, model: &str) -> bool {
    let model = model.trim();
    preset_search_capable(preset)
        && web_search_capable_for(&preset.provider, model, None, None)
        && agents.refuses_model(preset, model).is_none()
        && !is_own_orchestration(preset, model)
}

fn web_search_capable(agents: &Arc<Agents>, preset: &AgentPreset, model: &str) -> bool {
    model_web_search_capable(agents, preset, model) && agents.selectable(preset).is_ok()
}

fn pick_acp_search_model(agents: &Agents, preset: &AgentPreset, models: &crate::session::Models, skip_model: Option<&str>) -> Option<String> {
    if !preset_search_capable(preset) {
        return None;
    }
    let capable: Vec<String> = crate::tiers::offered(models, &preset.quirks)
        .into_iter()
        .map(|listed| listed.id)
        .filter(|id| skip_model != Some(id.as_str()) && model_web_search_capable(agents, preset, id))
        .collect();
    if let Some(picked) = pick_quick_web_search_model(&preset.provider, &capable) {
        return Some(picked);
    }
    if models.available.is_empty()
        && preset.quirks.runs_default
        && skip_model != Some(crate::agents::DEFAULT_MODEL)
        && model_web_search_capable(agents, preset, crate::agents::DEFAULT_MODEL)
    {
        return Some(crate::agents::DEFAULT_MODEL.to_owned());
    }
    None
}

fn sibling_failure_reason(preset: &AgentPreset, enabled: bool, state: &crate::agents::ObservedState) -> String {
    use crate::agents::Readiness;
    use crate::upkeep::Step;
    let name = format!("{} ({})", preset.label, preset.provider);
    if !enabled {
        return format!(
            "ACP agents are turned off in Settings; enable ACP agents and sign in to {name} in Settings, or open /websearch to choose another provider/model"
        );
    }
    match (state.readiness.as_ref(), state.running) {
        (_, Some(Step::Installing)) => {
            return format!("{name} is installing; wait for installation to finish, or open /websearch to choose another provider/model");
        }
        (Some(Readiness::VersionTooOld { version }), Some(Step::Updating)) => {
            return format!("{name} {version} is updating; wait for the update to finish, or open /websearch to choose another provider/model");
        }
        (_, Some(Step::Updating)) => {
            return format!("{name} is updating; wait for the update to finish, or open /websearch to choose another provider/model");
        }
        _ => {}
    }
    if let Some(message) = state.refused.as_deref() {
        return format!(
            "{name} refused the signed-in account: {message}; sign in to another account in Settings, or open /websearch to choose another provider/model"
        );
    }
    match (state.readiness.as_ref(), state.running) {
        (Some(Readiness::Ready { .. }), _) => {
            format!("{name} is ready, but offers no web-search-capable model; open /websearch to choose another provider/model")
        }
        (Some(Readiness::SignedOut { .. }), _) => {
            format!("{name} is signed out; sign in to {name} in Settings, or open /websearch to choose another provider/model")
        }
        (Some(Readiness::NotInstalled), _) => {
            format!("{name} is not installed; install and sign in to {name} in Settings, or open /websearch to choose another provider/model")
        }
        (Some(Readiness::VersionTooOld { version }), _) => {
            format!(
                "{name} {version} is too old ({} or later is needed); update it in Settings, or open /websearch to choose another provider/model",
                preset.minimum_version
            )
        }
        (Some(Readiness::VersionUnknown), _) => {
            format!("{name}'s version could not be read; check it in Settings, or open /websearch to choose another provider/model")
        }
        (Some(Readiness::Unsupported), _) => {
            format!("{name} does not run on this computer; open /websearch to choose another provider/model")
        }
        (Some(Readiness::Failed { message, .. }), _) => {
            format!("{name} did not start: {message}; open /websearch to choose another provider/model")
        }
        (Some(Readiness::Checking) | None, Some(Step::Checking)) => {
            format!("{name} is still being checked; try again shortly, or open /websearch to choose another provider/model")
        }
        (Some(Readiness::Checking) | None, None) => {
            format!("{name} has not finished checking yet; check it in Settings, or open /websearch to choose another provider/model")
        }
        (_, Some(Step::Installing | Step::Updating)) => unreachable!(),
    }
}

fn apply_model_settings(rows: &mut [Value], settings: &Map<String, Value>) {
    for row in rows {
        let key = format!("{}/{}", row["provider"].as_str().unwrap_or_default(), row["id"].as_str().unwrap_or_default());
        let (Some(saved), Some(row)) = (settings.get(&key), row.as_object_mut()) else { continue };
        if let Some(hidden @ Value::Bool(_)) = saved.get("hidden") {
            row.insert("savedHidden".to_owned(), hidden.clone());
        }
        if saved.get("favorite") == Some(&Value::Bool(true)) {
            row.insert("favorite".to_owned(), Value::Bool(true));
        }
        if row.contains_key("effortOptions") {
            row.insert("savedEffort".to_owned(), saved.get("effort").cloned().unwrap_or(Value::Null));
        }
    }
}

fn is_acp_route(provider: &str) -> bool {
    provider.starts_with("acp-")
}

fn norm_provider(value: &str) -> String {
    value.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

fn matches_acp_preset(preset: &AgentPreset, provider: &str) -> bool {
    let wanted = norm_provider(provider);
    !wanted.is_empty() && (norm_provider(&preset.provider) == wanted || norm_provider(&preset.id) == wanted)
}

fn unknown_acp_route_error(provider: &str) -> String {
    format!("ACP agent route \"{provider}\" is not available: no matching ACP agent preset is configured in Settings.")
}

/// [`RouteFacts`] that knows the agents' routes; every other provider is the catalog's.
pub struct AgentRouteFacts {
    pub inner: Arc<dyn RouteFacts>,
    pub agents: Arc<Agents>,
}

#[async_trait]
impl RouteFacts for AgentRouteFacts {
    fn is_known(&self, provider: &str, config: &Map<String, Value>) -> bool {
        // A saved route on an agent stays the agent's while its CLI is off or signed out, as a signed-out provider's
        // does: picking it is refused by `ensure_ready`, and a turn on it fails saying the agent's state.
        self.agents.preset_of_route(provider).is_some() || self.inner.is_known(provider, config)
    }

    /// As a provider's readiness waits for its initialization, an agent's waits for the check of its CLI that runs, or
    /// that it starts, and then says whether a route on it can be chosen.
    async fn ensure_ready(&self, config: &Map<String, Value>, provider: &str) -> Result<(), String> {
        match self.agents.preset_of_route(provider) {
            Some(preset) => {
                self.agents.ensure_checked(preset).await.map_err(|refusal| refusal.message(preset))?;
                self.agents.selectable(preset).map_err(|refusal| refusal.message(preset))
            }
            None if is_acp_route(provider) => Err(unknown_acp_route_error(provider)),
            None => self.inner.ensure_ready(config, provider).await,
        }
    }

    async fn ensure_route_ready(&self, config: &Map<String, Value>, provider: &str, model: &str) -> Result<(), String> {
        match self.agents.preset_of_route(provider) {
            Some(preset) => {
                let model = if model.is_empty() { crate::agents::DEFAULT_MODEL } else { model };
                if let Some(why) = self.agents.refuses_model(preset, model) {
                    return Err(why);
                }
                self.ensure_ready(config, provider).await
            }
            None if is_acp_route(provider) => Err(unknown_acp_route_error(provider)),
            None => self.inner.ensure_route_ready(config, provider, model).await,
        }
    }

    fn model_meta(&self, provider: &str, model: &str) -> Value {
        match self.agents.preset_of_route(provider) {
            Some(preset) => {
                let mut row = self.agents.model_row(preset, model);
                if let Some(obj) = row.as_object_mut() {
                    obj.insert("supportsWebSearch".to_owned(), Value::Bool(web_search_capable(&self.agents, preset, model)));
                }
                row
            }
            None => self.inner.model_meta(provider, model),
        }
    }

    async fn model_meta_fetching(&self, provider: &str, model: &str) -> Value {
        match self.agents.preset_of_route(provider) {
            Some(_) => self.model_meta(provider, model),
            None => self.inner.model_meta_fetching(provider, model).await,
        }
    }

    fn window_meta(&self, provider: &str, model: &str, meta: &Value) -> Option<Value> {
        match self.agents.preset_of_route(provider) {
            Some(preset) => self.agents.window_meta(preset, model),
            None => self.inner.window_meta(provider, model, meta),
        }
    }

    fn catalog_knows(&self, model: &str, provider: &str) -> bool {
        self.agents.preset_of_route(provider).is_some() || self.inner.catalog_knows(model, provider)
    }

    fn fast_capable(&self, provider: &str, meta: &Value, effort: Option<&str>, params: &Value) -> bool {
        self.agents.preset_of_route(provider).is_none() && self.inner.fast_capable(provider, meta, effort, params)
    }

    fn ultrafast_capable(&self, provider: &str, meta: &Value) -> bool {
        self.agents.preset_of_route(provider).is_none() && self.inner.ultrafast_capable(provider, meta)
    }

    /// A one-shot request on an agent's route is the agent's to answer; the agent is readied by the question itself,
    /// as a turn on it is. An unknown `acp-*` route fails with an ACP routing error instead of falling through to the
    /// HTTP provider registry.
    async fn sender(&self, providers: Option<&Map<String, Value>>, provider: &str) -> Result<Option<RouteSender>, String> {
        match self.agents.preset_of_route(provider) {
            Some(preset) => Ok(Some(RouteSender::Agent(Arc::new(AgentQuestion { agents: self.agents.clone(), preset: preset.clone() })))),
            None if is_acp_route(provider) => Err(unknown_acp_route_error(provider)),
            None => self.inner.sender(providers, provider).await,
        }
    }

    fn registered(&self, provider: &str) -> Option<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>> {
        self.agents.preset_of_route(provider).is_none().then(|| self.inner.registered(provider)).flatten()
    }

    fn init_error(&self, provider: &str) -> Option<String> {
        if self.agents.preset_of_route(provider).is_some() {
            None
        } else if is_acp_route(provider) {
            Some(unknown_acp_route_error(provider))
        } else {
            self.inner.init_error(provider)
        }
    }

    fn default_search_fallback(&self, config: &Map<String, Value>, main_provider: &str, main_model: &str) -> DefaultSearchFallback {
        let Some(main_preset) = self.agents.preset_of_route(main_provider) else {
            return self.inner.default_search_fallback(config, main_provider, main_model);
        };
        let siblings: Vec<&AgentPreset> =
            self.agents.presets().iter().filter(|p| p.tool_prefix == main_preset.tool_prefix && preset_search_capable(p)).collect();
        let enabled = self.agents.enabled();
        if !enabled {
            let empty = crate::agents::ObservedState { readiness: None, running: None, refused: None };
            let reason = if let Some(sibling) = siblings.first() {
                Some(sibling_failure_reason(sibling, false, &empty))
            } else if is_web_search_capable_provider(&main_preset.provider) {
                Some("ACP agents are turned off in Settings; open /websearch to choose another provider/model".to_owned())
            } else {
                None
            };
            return DefaultSearchFallback { route: None, reason };
        }
        let mut reason = None;
        for preset in siblings {
            let state = self.agents.observed_state(preset);
            if state.refused.is_none()
                && let Some(crate::agents::Readiness::Ready { models, .. }) = &state.readiness
            {
                let skip = (preset.provider == main_provider).then_some(main_model.trim());
                if let Some(model) = pick_acp_search_model(&self.agents, preset, models, skip) {
                    return DefaultSearchFallback { route: Some(DefaultSearchRoute { provider: preset.provider.clone(), model }), reason: None };
                }
            }
            if reason.is_none() {
                reason = Some(sibling_failure_reason(preset, true, &state));
            }
        }
        if reason.is_none() && is_web_search_capable_provider(&main_preset.provider) {
            reason = Some(format!("no search-capable {} preset is available; open /websearch to choose another provider/model", main_preset.label));
        }
        DefaultSearchFallback { route: None, reason }
    }
}

/// One question for the agent of a route, outside every conversation.
struct AgentQuestion {
    agents: Arc<Agents>,
    preset: AgentPreset,
}

#[async_trait]
impl AgentAsk for AgentQuestion {
    async fn ask(&self, model: &str, system: &str, prompt: &str) -> Result<AgentAnswer, String> {
        use mixdog_core_session::session::Clock as _;
        let now_ms = Arc::new(|| mixdog_core_session::session::SystemClock.now_ms());
        let answered = crate::runs::ask_once(&self.agents, &self.preset, model, system, prompt, now_ms).await?;
        let input_excludes_cache = answered.usage.as_ref().is_some_and(crate::surface::input_excludes_cache);
        Ok(AgentAnswer {
            text: answered.text,
            stop_reason: answered.stop_reason,
            usage: answered.usage.map(|usage| mixdog_core_api::domain::provider::Usage {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_tokens: usage.cached_read_tokens,
                reasoning_tokens: usage.thought_tokens,
                ..Default::default()
            }),
            input_excludes_cache,
        })
    }
}

/// [`RouteWriter`] for a session that may be on an agent's route: leaving the agent's preset's route ends the session
/// there, and an agent's route has no provider usage to read.
pub struct AgentRouteWriter {
    pub inner: Arc<dyn RouteWriter>,
    pub agents: Arc<Agents>,
}

impl AgentRouteWriter {
    fn on_agent(&self, route: &Route) -> bool {
        route.get("provider").and_then(Value::as_str).is_some_and(|provider| self.agents.preset_of_route(provider).is_some())
    }
}

#[async_trait]
impl RouteWriter for AgentRouteWriter {
    fn route(&self, thread: &ThreadId) -> Route {
        self.inner.route(thread)
    }

    /// A session whose route leaves the preset its agent runs on (for a provider, or for another preset of the agent)
    /// has no use for that agent's session from that moment: it is ended here, not at the session's next turn, which may
    /// never come. A turn that runs in it meanwhile (the switch takes effect at the next turn) is not cut off: the session
    /// ends when that turn is over, unless the route came back to the preset by then. On a shared server the session
    /// alone leaves it.
    fn set_route_state(&self, thread: &ThreadId, route: Route) {
        let preset = route.get("provider").and_then(Value::as_str).and_then(|provider| self.agents.preset_of_route(provider));
        if let Some(running) = self.agents.running(thread) {
            if preset.is_some_and(|preset| preset.id == running.preset.id) {
                running.keep_after_turn();
            } else if !running.end_after_turn() {
                self.agents.end_process(thread);
            }
        }
        self.inner.set_route_state(thread, route);
    }

    fn generation(&self, thread: &ThreadId) -> u64 {
        self.inner.generation(thread)
    }

    async fn refresh_route_effort(
        &self,
        thread: &ThreadId,
        meta: Option<Value>,
        guard_supersede: bool,
        lease: Option<u64>,
    ) -> Result<Option<Route>, PortError> {
        self.inner.refresh_route_effort(thread, meta, guard_supersede, lease).await
    }

    fn refresh_statusline_usage(&self, thread: &ThreadId, route: &Route) {
        if !self.on_agent(route) {
            self.inner.refresh_statusline_usage(thread, route);
        }
    }

    fn boot(&self, thread: &ThreadId, request: &Route) {
        self.inner.boot(thread, request);
    }
}

/// `model/list` with the agents' entries after the catalog's rows.
pub struct AgentModelList {
    pub inner: Arc<dyn DomainService>,
    pub agents: Arc<Agents>,
    /// The saved `modelSettings` (`"<provider>/<model>"` → the model's favourite and hidden marks).
    pub settings: Arc<dyn Fn() -> Map<String, Value> + Send + Sync>,
}

impl AgentModelList {
    /// The agents' rows with the marks the user saved for them, under the keys a provider's row carries them.
    fn rows(&self) -> Vec<Value> {
        let settings = (self.settings)();
        let mut rows = self.agents.picker_rows();
        apply_model_settings(&mut rows, &settings);
        rows
    }
}

#[async_trait]
impl DomainService for AgentModelList {
    fn methods(&self) -> &'static [&'static str] {
        self.inner.methods()
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let reply = self.inner.call(req).await?;
        let rows = self.rows();
        Ok(match reply {
            Reply::Value(Value::Array(mut models)) => {
                models.extend(rows);
                Reply::Value(Value::Array(models))
            }
            Reply::Value(Value::Object(mut read)) => {
                if let Some(Value::Array(models)) = read.get_mut("models") {
                    models.extend(rows);
                }
                Reply::Value(Value::Object(read))
            }
            other => other,
        })
    }

    fn notify(&self, method: Method, params: Value, from: ConnectionId) -> Admit {
        self.inner.notify(method, params, from)
    }
}

/// [`ModelCatalog`] with the ACP agents' rows alongside the provider catalog's.
pub struct AgentModelCatalog {
    pub inner: Arc<dyn ModelCatalog>,
    pub agents: Arc<Agents>,
    /// The saved `modelSettings` (`"<provider>/<model>"` → the model's favourite, hidden and effort marks).
    pub settings: Arc<dyn Fn() -> Map<String, Value> + Send + Sync>,
}

impl AgentModelCatalog {
    fn matching_presets(&self, provider: &str) -> Vec<&AgentPreset> {
        self.agents.presets().iter().filter(|preset| matches_acp_preset(preset, provider)).collect()
    }

    fn rows(&self, catalog_complete: bool) -> Vec<ModelRow> {
        let settings = (self.settings)();
        let mut rows = self.agents.ready_picker_rows();
        apply_model_settings(&mut rows, &settings);
        let text = |row: &Value, key: &str| row.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        rows.into_iter()
            .map(|row| ModelRow { provider: text(&row, "provider"), id: text(&row, "id"), display: text(&row, "display"), catalog_complete, row })
            .collect()
    }
}

#[async_trait]
impl ModelCatalog for AgentModelCatalog {
    async fn list(&self, options: ListOptions) -> Result<Vec<ModelRow>, String> {
        if !options.quick
            && self.agents.enabled()
            && let Some(provider) = options.provider.as_deref().map(str::trim).filter(|p| !p.is_empty())
        {
            for preset in self.matching_presets(provider) {
                let _ = self.agents.ensure_checked(preset).await;
            }
        }
        let mut rows = self.inner.list(options.clone()).await?;
        let catalog_complete = options.quick && !options.force && rows.iter().all(|row| row.catalog_complete);
        rows.extend(self.rows(catalog_complete));
        Ok(rows)
    }

    async fn agent_provider(&self, agent: &str) -> Option<String> {
        self.inner.agent_provider(agent).await
    }

    async fn provider_state(&self, provider: &str) -> Option<String> {
        if let Some(preset) = self.agents.presets().iter().find(|preset| matches_acp_preset(preset, provider)) {
            return self.agents.selectable(preset).err().map(|refusal| refusal.message(preset));
        }
        self.inner.provider_state(provider).await
    }
}

/// `account/listWebSearchModels` with the ready web-search-capable agents' entries after the catalog's rows.
pub struct AgentWebSearchModels {
    pub inner: Arc<dyn WebSearchModels>,
    pub agents: Arc<Agents>,
    /// The saved `modelSettings` (`"<provider>/<model>"` → the model's favourite, hidden and effort marks).
    pub settings: Arc<dyn Fn() -> Map<String, Value> + Send + Sync>,
}

impl AgentWebSearchModels {
    fn rows(&self) -> Vec<Value> {
        let settings = (self.settings)();
        let mut rows: Vec<Value> = self
            .agents
            .picker_rows()
            .into_iter()
            .filter_map(|mut row| {
                let provider = row.get("provider").and_then(Value::as_str)?;
                let id = row.get("id").and_then(Value::as_str)?;
                let preset = self.agents.preset_of_route(provider)?;
                if !web_search_capable(&self.agents, preset, id) {
                    return None;
                }
                if let Some(obj) = row.as_object_mut() {
                    obj.insert("supportsWebSearch".to_owned(), Value::Bool(true));
                    obj.insert("webSearchCapable".to_owned(), Value::Bool(true));
                    obj.insert("webSearchToolType".to_owned(), Value::String("web_search".to_owned()));
                    obj.insert("mode".to_owned(), Value::String("chat".to_owned()));
                }
                Some(row)
            })
            .collect();
        apply_model_settings(&mut rows, &settings);
        rows
    }
}

#[async_trait]
impl WebSearchModels for AgentWebSearchModels {
    async fn list(&self, thread: Option<&ThreadId>, force: bool) -> Result<Value, Failure> {
        let mut value = self.inner.list(thread, force).await?;
        let rows = self.rows();
        if let Value::Array(models) = &mut value {
            models.retain(|row| row.get("provider").and_then(Value::as_str).is_none_or(|provider| self.agents.preset_of_route(provider).is_none()));
            models.extend(rows);
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};

    use mixdog_core_api::domain::common::AbsPath;
    use serde_json::json;

    use super::*;
    use crate::agents::{AgentsParts, Readiness, Refusals, Windows, lock};
    use crate::files::TextFiles;
    use crate::preset::{AgentPreset, builtin};
    use crate::session::{AgentModel, Models, Program};
    use crate::upkeep::Slot;

    #[derive(Default)]
    struct NoRefusals;

    #[async_trait]
    impl Refusals for NoRefusals {
        async fn read(&self) -> HashMap<String, String> {
            HashMap::new()
        }
        async fn keep(&self, _: HashMap<String, String>) {}
        async fn read_windows(&self) -> Windows {
            Windows::new()
        }
        async fn keep_windows(&self, _: Windows) {}
    }

    struct NoFiles;

    #[async_trait]
    impl TextFiles for NoFiles {
        async fn read(&self, _: AbsPath) -> Result<String, String> {
            Err("unused".into())
        }
        async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
            Ok(path)
        }
        async fn create(&self, _: AbsPath, _: String) -> Result<(), String> {
            Ok(())
        }
    }

    struct EmptyFacts;

    #[async_trait]
    impl RouteFacts for EmptyFacts {
        fn is_known(&self, _: &str, _: &Map<String, Value>) -> bool {
            false
        }
        async fn ensure_ready(&self, _: &Map<String, Value>, provider: &str) -> Result<(), String> {
            Err(format!("unknown provider {provider}"))
        }
        fn model_meta(&self, _: &str, _: &str) -> Value {
            Value::Null
        }
        fn window_meta(&self, _: &str, _: &str, _: &Value) -> Option<Value> {
            None
        }
        fn catalog_knows(&self, _: &str, _: &str) -> bool {
            false
        }
        fn fast_capable(&self, _: &str, _: &Value, _: Option<&str>, _: &Value) -> bool {
            false
        }
        fn ultrafast_capable(&self, _: &str, _: &Value) -> bool {
            false
        }
        async fn sender(&self, _: Option<&Map<String, Value>>, _: &str) -> Result<Option<RouteSender>, String> {
            Ok(None)
        }
        fn registered(&self, _: &str) -> Option<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>> {
            None
        }
        fn init_error(&self, _: &str) -> Option<String> {
            None
        }
    }

    struct StaticWebSearchModels(Value);

    #[async_trait]
    impl WebSearchModels for StaticWebSearchModels {
        async fn list(&self, _: Option<&ThreadId>, _: bool) -> Result<Value, Failure> {
            Ok(self.0.clone())
        }
    }

    fn build_agents(presets: Vec<AgentPreset>, enabled: Arc<AtomicBool>) -> (tempfile::TempDir, Arc<Agents>) {
        let dir = tempfile::tempdir().unwrap();
        let processes = Arc::new(mixdog_spawn::LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, mixdog_spawn::ProcessConfig::default()));
        let agents = Agents::new(AgentsParts {
            refusals: Arc::new(NoRefusals),
            presets,
            processes,
            files: Arc::new(NoFiles),
            fit: crate::mcp::in_process_fit(),
            enabled: {
                let enabled = enabled.clone();
                Arc::new(move || enabled.load(Ordering::SeqCst))
            },
            changed: Arc::new(|| {}),
            probe_cwd: dir.path().to_path_buf(),
            definitions: dir.path().join("defs"),
            data_dir: dir.path().join("data"),
            env: Arc::new(|_| None),
            mcp_bridge: None,
            registry: None,
        });
        (dir, agents)
    }

    fn seed_slot(agents: &Agents, preset_id: &str, readiness: Readiness) {
        let mut slots = lock(&agents.slots);
        let mut slot = Slot::default();
        slot.readiness = Some(readiness);
        slot.program = Some(Program::at("stub"));
        slots.insert(preset_id.to_owned(), slot);
    }

    fn models(list: &[(&str, &str)]) -> Models {
        Models {
            available: list.iter().map(|(id, name)| AgentModel { id: (*id).to_owned(), name: (*name).to_owned() }).collect(),
            current: list.first().map(|(id, _)| (*id).to_owned()),
            config_option: None,
        }
    }

    #[tokio::test]
    async fn agent_route_facts_marks_web_search_capability_and_excludes_own_orchestration() {
        let mut presets = builtin();
        let mut other = presets[0].clone();
        other.id = "other-agent".into();
        other.provider = "acp-other".into();
        presets.push(other);

        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(presets, enabled.clone());
        seed_slot(
            &agents,
            "antigravity",
            Readiness::Ready { version: "1.5.2".into(), models: models(&[("gemini-3-flash", "Gemini 3 Flash"), ("gemini-pro-orchestrator", "Orchestrator")]) },
        );
        seed_slot(&agents, "antigravity-cli", Readiness::SignedOut { version: "1.5.16".into(), message: "sign in".into() });

        let facts = AgentRouteFacts { inner: Arc::new(EmptyFacts), agents: agents.clone() };
        let empty = Map::new();

        assert_eq!(facts.ensure_ready(&empty, "acp-antigravity").await, Ok(()));
        assert!(facts.ensure_ready(&empty, "acp-antigravity-cli").await.unwrap_err().contains("signed out"));

        assert_eq!(facts.model_meta("acp-antigravity", "gemini-3-flash")["supportsWebSearch"], json!(true));
        assert_eq!(facts.model_meta("acp-antigravity", "gemini-pro-orchestrator")["supportsWebSearch"], json!(false));
        assert_eq!(facts.model_meta("acp-antigravity", "claude-opus-4-6")["supportsWebSearch"], json!(false));
        // Signed-out agent is not selectable, so its models are not marked web-search capable.
        assert_eq!(facts.model_meta("acp-antigravity-cli", "claude-opus-4-6")["supportsWebSearch"], json!(false));
        assert_eq!(facts.model_meta("acp-antigravity-cli", "gemini-3-flash")["supportsWebSearch"], json!(false));
        assert_eq!(facts.model_meta("acp-other", "gemini-3-flash")["supportsWebSearch"], json!(false));

        seed_slot(&agents, "antigravity-cli", Readiness::Ready { version: "1.5.16".into(), models: models(&[("claude-opus-4-6", "Claude Opus 4.6")]) });
        // `antigravity-cli` uses `OwnToolsOff::AgentFile`, so search-only isolation is fail-closed unavailable.
        assert_eq!(facts.model_meta("acp-antigravity-cli", "claude-opus-4-6")["supportsWebSearch"], json!(false));
        assert_eq!(facts.model_meta("acp-antigravity-cli", "gemini-3-flash")["supportsWebSearch"], json!(false));

        enabled.store(false, Ordering::SeqCst);
        assert!(facts.ensure_ready(&empty, "acp-antigravity").await.unwrap_err().contains("turned off"));
        assert_eq!(facts.model_meta("acp-antigravity", "gemini-3-flash")["supportsWebSearch"], json!(false));
        assert_eq!(facts.model_meta("acp-antigravity-cli", "claude-opus-4-6")["supportsWebSearch"], json!(false));
    }

    #[tokio::test]
    async fn agent_route_facts_rejects_non_chat_models_for_web_search() {
        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled);
        seed_slot(
            &agents,
            "antigravity",
            Readiness::Ready { version: "1.5.2".into(), models: models(&[("gemini-3-flash", "Gemini 3 Flash"), ("gemini-embedding-001", "Gemini Embedding")]) },
        );
        seed_slot(
            &agents,
            "antigravity-cli",
            Readiness::Ready {
                version: "1.5.16".into(),
                models: models(&[("claude-opus-4-6", "Claude Opus 4.6"), ("text-embedding-001", "Text Embedding"), ("whisper-1", "Whisper")]),
            },
        );

        let facts = AgentRouteFacts { inner: Arc::new(EmptyFacts), agents: agents.clone() };
        for (provider, id) in [("acp-antigravity", "gemini-embedding-001"), ("acp-antigravity-cli", "text-embedding-001"), ("acp-antigravity-cli", "whisper-1")]
        {
            let meta = facts.model_meta(provider, id);
            assert_eq!(meta["supportsWebSearch"], json!(false), "{provider}/{id}");
            assert!(!web_search_capable_for(provider, id, Some(&meta), None), "{provider}/{id} must not pass web_search_capable_for");
        }

        let decorator = AgentWebSearchModels { inner: Arc::new(StaticWebSearchModels(json!([]))), agents, settings: Arc::new(Map::new) };
        let listed = decorator.list(None, false).await.unwrap();
        let pairs: Vec<(&str, &str)> = listed.as_array().unwrap().iter().map(|r| (r["provider"].as_str().unwrap(), r["id"].as_str().unwrap())).collect();
        assert_eq!(pairs, [("acp-antigravity", "gemini-3-flash")]);
    }

    #[tokio::test]
    async fn unready_or_disabled_acp_agent_emits_no_web_search_rows() {
        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled.clone());
        seed_slot(&agents, "antigravity", Readiness::SignedOut { version: "1.5.2".into(), message: "sign in".into() });
        seed_slot(&agents, "antigravity-cli", Readiness::Ready { version: "1.5.16".into(), models: models(&[("claude-opus-4-6", "Claude Opus 4.6")]) });

        let decorator = AgentWebSearchModels {
            inner: Arc::new(StaticWebSearchModels(json!([
                { "provider": "openai", "id": "gpt-5.2", "supportsWebSearch": true },
                { "provider": "acp-antigravity", "id": "gemini-3-flash", "supportsWebSearch": true },
                { "provider": "acp-antigravity-cli", "id": "claude-opus-4-6", "supportsWebSearch": true }
            ]))),
            agents: agents.clone(),
            settings: Arc::new(Map::new),
        };

        let listed = decorator.list(None, false).await.unwrap();
        let pairs: Vec<(&str, &str)> = listed.as_array().unwrap().iter().map(|r| (r["provider"].as_str().unwrap(), r["id"].as_str().unwrap())).collect();
        assert_eq!(pairs, [("openai", "gpt-5.2")]);

        seed_slot(&agents, "antigravity", Readiness::Ready { version: "1.5.2".into(), models: models(&[("gemini-3-flash", "Gemini 3 Flash")]) });
        let listed = decorator.list(None, false).await.unwrap();
        let pairs: Vec<(&str, &str)> = listed.as_array().unwrap().iter().map(|r| (r["provider"].as_str().unwrap(), r["id"].as_str().unwrap())).collect();
        assert_eq!(pairs, [("openai", "gpt-5.2"), ("acp-antigravity", "gemini-3-flash")]);
        assert_eq!(listed.as_array().unwrap()[1]["runner"], "acp");

        enabled.store(false, Ordering::SeqCst);
        let listed = decorator.list(None, false).await.unwrap();
        let pairs: Vec<(&str, &str)> = listed.as_array().unwrap().iter().map(|r| (r["provider"].as_str().unwrap(), r["id"].as_str().unwrap())).collect();
        assert_eq!(pairs, [("openai", "gpt-5.2")]);
    }

    #[tokio::test]
    async fn agent_file_presets_are_excluded_from_web_search_advertising() {
        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled);
        seed_slot(&agents, "antigravity", Readiness::Ready { version: "1.5.2".into(), models: models(&[("gemini-3-flash", "Gemini 3 Flash")]) });
        seed_slot(&agents, "antigravity-cli", Readiness::Ready { version: "1.5.16".into(), models: models(&[("claude-opus-4-6", "Claude Opus 4.6")]) });

        let cli_preset = agents.preset_of_route("acp-antigravity-cli").expect("antigravity-cli preset");
        assert!(matches!(cli_preset.own_tools_off, Some(crate::preset::OwnToolsOff::AgentFile(_))));
        assert!(crate::search::search_only_preset(cli_preset).is_err());

        let facts = AgentRouteFacts { inner: Arc::new(EmptyFacts), agents: agents.clone() };
        assert_eq!(facts.model_meta("acp-antigravity", "gemini-3-flash")["supportsWebSearch"], json!(true));
        assert_eq!(facts.model_meta("acp-antigravity-cli", "claude-opus-4-6")["supportsWebSearch"], json!(false));

        let decorator = AgentWebSearchModels {
            inner: Arc::new(StaticWebSearchModels(json!([
                { "provider": "acp-antigravity-cli", "id": "claude-opus-4-6", "supportsWebSearch": true }
            ]))),
            agents,
            settings: Arc::new(Map::new),
        };
        let listed = decorator.list(None, false).await.unwrap();
        let pairs: Vec<(&str, &str)> = listed.as_array().unwrap().iter().map(|r| (r["provider"].as_str().unwrap(), r["id"].as_str().unwrap())).collect();
        assert_eq!(pairs, [("acp-antigravity", "gemini-3-flash")]);
    }

    #[tokio::test]
    async fn agent_web_search_models_lists_ready_presets_excludes_own_orchestration_and_replaces_bare_duplicates() {
        let mut presets = builtin();
        let mut non_search = presets[0].clone();
        non_search.id = "non-search".into();
        non_search.provider = "acp-non-search".into();
        presets.push(non_search);

        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(presets, enabled);
        seed_slot(
            &agents,
            "antigravity",
            Readiness::Ready {
                version: "1.5.2".into(),
                models: models(&[
                    ("gemini-3-flash", "Gemini 3 Flash"),
                    ("gemini-pro-orchestrator", "Orchestrator"),
                    ("gemini-3-pro-low", "Gemini 3 Pro (Low)"),
                    ("gemini-3-pro-high", "Gemini 3 Pro (High)"),
                ]),
            },
        );
        seed_slot(
            &agents,
            "antigravity-cli",
            Readiness::Ready { version: "1.5.16".into(), models: models(&[("claude-opus-4-6", "Claude Opus 4.6"), ("gemini-3-flash", "Gemini 3 Flash")]) },
        );
        seed_slot(&agents, "non-search", Readiness::Ready { version: "1.0.0".into(), models: models(&[("gemini-3-flash", "Gemini 3 Flash")]) });

        let inner = Arc::new(StaticWebSearchModels(json!([
            { "provider": "default", "id": "default", "supportsWebSearch": true },
            { "provider": "openai", "id": "gpt-5.2", "supportsWebSearch": true },
            { "provider": "acp-antigravity", "id": "gemini-3-flash", "supportsWebSearch": true }
        ])));
        let saved = json!({
            "acp-antigravity/gemini-3-flash": { "favorite": true },
            "acp-antigravity/gemini-3-pro": { "effort": "high" },
            "acp-antigravity-cli/claude-opus-4-6": { "hidden": true }
        });
        let decorator = AgentWebSearchModels { inner, agents, settings: Arc::new(move || saved.as_object().cloned().unwrap_or_default()) };

        let listed = decorator.list(None, false).await.unwrap();
        let rows = listed.as_array().unwrap();
        let pairs: Vec<(&str, &str)> = rows.iter().map(|r| (r["provider"].as_str().unwrap(), r["id"].as_str().unwrap())).collect();
        assert_eq!(pairs, [("default", "default"), ("openai", "gpt-5.2"), ("acp-antigravity", "gemini-3-flash"), ("acp-antigravity", "gemini-3-pro"),]);
        let flash = rows.iter().find(|r| r["provider"] == "acp-antigravity" && r["id"] == "gemini-3-flash").unwrap();
        assert_eq!(flash["runner"], "acp");
        assert_eq!(flash["supportsWebSearch"], true);
        assert_eq!(flash["webSearchCapable"], true);
        assert_eq!(flash["webSearchToolType"], "web_search");
        assert_eq!(flash["favorite"], true);

        let pro = rows.iter().find(|r| r["provider"] == "acp-antigravity" && r["id"] == "gemini-3-pro").unwrap();
        assert_eq!(pro["savedEffort"], "high");
    }

    #[tokio::test]
    async fn agent_route_facts_sender_returns_acp_routing_error_for_unknown_acp_route() {
        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled);
        let facts = AgentRouteFacts { inner: Arc::new(EmptyFacts), agents };
        let empty = Map::new();

        let err = match facts.sender(None, "acp-unknown").await {
            Err(err) => err,
            Ok(_) => panic!("unknown acp-* route must fail with an ACP routing error"),
        };
        assert!(err.contains("ACP agent route"), "unexpected error: {err}");
        assert!(!err.contains("/providers") && !err.contains("API key"), "must not emit misleading HTTP auth error: {err}");

        let ready_err = facts.ensure_ready(&empty, "acp-unknown").await.unwrap_err();
        assert!(ready_err.contains("ACP agent route"), "unexpected ensure_ready error: {ready_err}");
        assert!(facts.init_error("acp-unknown").as_deref().is_some_and(|e| e.contains("ACP agent route")));
    }

    #[tokio::test]
    async fn agent_route_facts_ensure_ready_preserves_in_flight_update_via_ensure_checked() {
        use tokio::sync::watch;
        use tokio_util::sync::CancellationToken;

        use crate::upkeep::Running;
        use crate::upkeep::Step;

        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled);
        let facts = AgentRouteFacts { inner: Arc::new(EmptyFacts), agents: agents.clone() };
        let empty = Map::new();

        // Case 1: already Ready with an active Step::Updating — ensure_ready returns Ok immediately without cancelling.
        let (step_tx, _step_rx) = watch::channel(Step::Updating);
        let (_done_tx, done_rx) = watch::channel(false);
        let cancel = CancellationToken::new();
        {
            let mut slots = lock(&agents.slots);
            let mut slot = Slot::default();
            slot.readiness = Some(Readiness::Ready { version: "1.5.2".into(), models: models(&[("gemini-3-flash", "Gemini 3 Flash")]) });
            slot.program = Some(Program::at("stub"));
            slot.running = Some(Running::for_test(step_tx, cancel.clone(), done_rx));
            slots.insert("antigravity".to_owned(), slot);
        }
        assert_eq!(facts.ensure_ready(&empty, "acp-antigravity").await, Ok(()));
        assert!(!cancel.is_cancelled(), "ensure_ready must never cancel an in-flight Step::Updating");
        assert!(lock(&agents.slots).get("antigravity").and_then(|s| s.running.as_ref()).is_some());

        // Case 2: readiness not yet populated while Step::Updating is in flight — waits without cancelling until ready.
        let (step_tx2, _step_rx2) = watch::channel(Step::Updating);
        let (done_tx2, done_rx2) = watch::channel(false);
        let cancel2 = CancellationToken::new();
        {
            let mut slots = lock(&agents.slots);
            let mut slot = Slot::default();
            slot.readiness = None;
            slot.running = Some(Running::for_test(step_tx2, cancel2.clone(), done_rx2));
            slots.insert("antigravity".to_owned(), slot);
        }
        let facts_bg = AgentRouteFacts { inner: Arc::new(EmptyFacts), agents: agents.clone() };
        let check = tokio::spawn(async move {
            let empty = Map::new();
            facts_bg.ensure_ready(&empty, "acp-antigravity").await
        });
        tokio::task::yield_now().await;
        assert!(!cancel2.is_cancelled(), "waiting ensure_ready must not cancel Step::Updating");
        assert!(!check.is_finished(), "ensure_ready should wait while readiness is None and update is running");
        {
            let mut slots = lock(&agents.slots);
            let slot = slots.get_mut("antigravity").unwrap();
            slot.readiness = Some(Readiness::Ready { version: "1.5.3".into(), models: models(&[("gemini-3-flash", "Gemini 3 Flash")]) });
            slot.running = None;
        }
        let _ = done_tx2.send(true);
        assert_eq!(check.await.unwrap(), Ok(()));
        assert!(!cancel2.is_cancelled(), "Step::Updating must remain uncancelled after ensure_ready completes");
    }

    struct EmptyCatalog;

    #[async_trait]
    impl ModelCatalog for EmptyCatalog {
        async fn list(&self, _: ListOptions) -> Result<Vec<ModelRow>, String> {
            Ok(Vec::new())
        }
    }

    struct StaticCatalog {
        rows: Vec<ModelRow>,
        own: Option<&'static str>,
    }

    #[async_trait]
    impl ModelCatalog for StaticCatalog {
        async fn list(&self, _: ListOptions) -> Result<Vec<ModelRow>, String> {
            Ok(self.rows.clone())
        }
        async fn agent_provider(&self, _: &str) -> Option<String> {
            self.own.map(str::to_owned)
        }
    }

    #[tokio::test]
    async fn agent_model_catalog_resolves_signed_in_acp_models_by_id_display_and_words() {
        use mixdog_agent::agent_tool::model_select::resolve_requested_model;

        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled);
        seed_slot(
            &agents,
            "antigravity",
            Readiness::Ready {
                version: "1.5.2".into(),
                models: models(&[
                    ("gemini-4-neon-low", "Gemini 4 Neon (Low)"),
                    ("gemini-4-neon-medium", "Gemini 4 Neon (Medium)"),
                    ("gemini-4-neon-high", "Gemini 4 Neon (High)"),
                    ("gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"),
                    ("gemini-3-flash", "Gemini 3 Flash"),
                    ("gemini-pro-orchestrator", "Orchestrator"),
                ]),
            },
        );
        seed_slot(
            &agents,
            "antigravity-cli",
            Readiness::Ready {
                version: "1.5.16".into(),
                models: models(&[
                    ("claude-opus-5-5-low", "Claude Opus 5.5 (Low)"),
                    ("claude-opus-5-5-high", "Claude Opus 5.5 (High)"),
                    ("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"),
                ]),
            },
        );
        let saved = json!({
            "acp-antigravity/gemini-4-neon": { "effort": "xhigh" }
        });
        let catalog = AgentModelCatalog { inner: Arc::new(EmptyCatalog), agents, settings: Arc::new(move || saved.as_object().cloned().unwrap_or_default()) };

        for query in ["gemini-4-neon", "Antigravity · Gemini 4 Neon", "Gemini 4 Neon", "4 neon"] {
            let (routed, note) = resolve_requested_model(&json!({ "provider": "acp-antigravity", "model": query }), Some(&catalog)).await.expect(query);
            assert_eq!(routed["provider"], "acp-antigravity", "{query}");
            assert_eq!(routed["model"], "gemini-4-neon", "{query}");
            assert_eq!(routed["modelDefaults"]["effort"], "xhigh", "{query}");
            assert_eq!(routed["modelDefaults"]["fast"], false, "{query}");
            assert_eq!(routed["modelDefaults"]["efforts"], json!(["low", "medium", "high", "xhigh"]), "{query}");
            assert_eq!(note, "runs on acp-antigravity/gemini-4-neon", "{query}");
        }

        // Exact preset id also resolves to its preset without matching siblings.
        let (by_preset, note) = resolve_requested_model(&json!({ "provider": "antigravity", "model": "gemini-4-neon" }), Some(&catalog)).await.unwrap();
        assert_eq!((by_preset["provider"].as_str(), by_preset["model"].as_str()), (Some("acp-antigravity"), Some("gemini-4-neon")));
        assert_eq!(note, "runs on acp-antigravity/gemini-4-neon");

        for query in ["claude-opus-5-5", "Antigravity · Claude Opus 5.5", "opus 5.5"] {
            let (routed, note) = resolve_requested_model(&json!({ "provider": "acp-antigravity-cli", "model": query }), Some(&catalog)).await.expect(query);
            assert_eq!(routed["provider"], "acp-antigravity-cli", "{query}");
            assert_eq!(routed["model"], "claude-opus-5-5", "{query}");
            assert_eq!(note, "runs on acp-antigravity-cli/claude-opus-5-5", "{query}");
        }

        let fast_err =
            resolve_requested_model(&json!({ "provider": "acp-antigravity", "model": "gemini-4-neon", "fast": true }), Some(&catalog)).await.unwrap_err();
        assert!(fast_err.contains("does not support fast"), "{fast_err}");
    }

    #[tokio::test]
    async fn agent_model_catalog_refuses_acp_providers_offering_no_models() {
        use mixdog_agent::agent_tool::model_select::resolve_requested_model;

        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled.clone());
        seed_slot(&agents, "antigravity", Readiness::SignedOut { version: "1.5.2".into(), message: "sign in".into() });
        seed_slot(&agents, "antigravity-cli", Readiness::Ready { version: "1.5.16".into(), models: models(&[("claude-opus-5-5", "Claude Opus 5.5")]) });
        let catalog = AgentModelCatalog { inner: Arc::new(EmptyCatalog), agents: agents.clone(), settings: Arc::new(Map::new) };

        let signed_out = resolve_requested_model(&json!({ "provider": "acp-antigravity", "model": "gemini-4-neon" }), Some(&catalog)).await.unwrap_err();
        assert!(signed_out.contains("acp-antigravity") && signed_out.contains("has no available models") && signed_out.contains("signed out"), "{signed_out}");

        // Must not spill into `acp-antigravity-cli` under provider id, normalized spelling, preset id, or substring.
        for provider in ["acp-antigravity", "acp_antigravity", "antigravity"] {
            let no_spill = resolve_requested_model(&json!({ "provider": provider, "model": "claude-opus-5-5" }), Some(&catalog)).await.unwrap_err();
            assert!(no_spill.contains(provider) && no_spill.contains("signed out"), "{provider}: {no_spill}");
        }
        let sub = resolve_requested_model(&json!({ "provider": "anti", "model": "claude-opus-5-5" }), Some(&catalog)).await.unwrap_err();
        assert_eq!(sub, "agent spawn: provider \"anti\" has no available models");

        // A signed-in ACP provider that reports no offered models still gets a clear refusal.
        seed_slot(&agents, "antigravity", Readiness::Ready { version: "1.5.2".into(), models: models(&[("gemini-pro-orchestrator", "Orchestrator")]) });
        let empty = resolve_requested_model(&json!({ "provider": "acp-antigravity", "model": "gemini-4-neon" }), Some(&catalog)).await.unwrap_err();
        assert_eq!(empty, "agent spawn: provider \"acp-antigravity\" has no available models");

        // An unknown ACP provider gets a clear refusal.
        let unknown = resolve_requested_model(&json!({ "provider": "acp-unknown", "model": "gemini-4-neon" }), Some(&catalog)).await.unwrap_err();
        assert_eq!(unknown, "agent spawn: provider \"acp-unknown\" has no available models");

        // When external agents are turned off, refusal states why.
        enabled.store(false, Ordering::SeqCst);
        let off = resolve_requested_model(&json!({ "provider": "acp-antigravity-cli", "model": "claude-opus-5-5" }), Some(&catalog)).await.unwrap_err();
        assert!(off.contains("acp-antigravity-cli") && off.contains("turned off"), "{off}");
    }

    #[tokio::test]
    async fn agent_model_catalog_keeps_model_only_spawns_on_non_acp_unless_agent_owns_acp_route() {
        use mixdog_agent::agent_tool::model_select::resolve_requested_model;

        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled);
        seed_slot(&agents, "antigravity", Readiness::Ready { version: "1.5.2".into(), models: models(&[("gemini-4-neon", "Gemini 4 Neon")]) });
        seed_slot(&agents, "antigravity-cli", Readiness::Ready { version: "1.5.16".into(), models: models(&[("claude-opus-5-5", "Claude Opus 5.5")]) });
        let non_acp = vec![ModelRow {
            provider: "anthropic-oauth".into(),
            id: "claude-opus-5-5".into(),
            display: "Claude Opus 5.5".into(),
            catalog_complete: true,
            row: json!({}),
        }];

        let no_agent =
            AgentModelCatalog { inner: Arc::new(StaticCatalog { rows: non_acp.clone(), own: None }), agents: agents.clone(), settings: Arc::new(Map::new) };
        let (routed, note) = resolve_requested_model(&json!({ "model": "claude-opus-5-5" }), Some(&no_agent)).await.unwrap();
        assert_eq!((routed["provider"].as_str(), routed["model"].as_str()), (Some("anthropic-oauth"), Some("claude-opus-5-5")));
        assert_eq!(note, "runs on anthropic-oauth/claude-opus-5-5");

        let acp_owned =
            AgentModelCatalog { inner: Arc::new(StaticCatalog { rows: non_acp, own: Some("acp-antigravity") }), agents, settings: Arc::new(Map::new) };
        let (routed, note) = resolve_requested_model(&json!({ "agent": "writer", "model": "gemini-4-neon" }), Some(&acp_owned)).await.unwrap();
        assert_eq!((routed["provider"].as_str(), routed["model"].as_str()), (Some("acp-antigravity"), Some("gemini-4-neon")));
        assert_eq!(note, "runs on acp-antigravity/gemini-4-neon");
        let (other, _) = resolve_requested_model(&json!({ "agent": "writer", "model": "claude-opus-5-5" }), Some(&acp_owned)).await.unwrap();
        assert_eq!(other["provider"], "anthropic-oauth");
    }

    #[tokio::test]
    async fn agent_model_catalog_does_not_wait_on_unchecked_acp_presets_when_no_provider_is_given() {
        use mixdog_agent::agent_tool::model_select::resolve_requested_model;
        use tokio::sync::watch;
        use tokio_util::sync::CancellationToken;

        use crate::upkeep::{Running, Step};

        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled);
        // Leave `antigravity` in an in-flight check that never finishes and `antigravity-cli` never checked.
        let (step_tx, _step_rx) = watch::channel(Step::Checking);
        let (_done_tx, done_rx) = watch::channel(false);
        {
            let mut slots = lock(&agents.slots);
            let mut slot = Slot::default();
            slot.readiness = None;
            slot.running = Some(Running::for_test(step_tx, CancellationToken::new(), done_rx));
            slots.insert("antigravity".to_owned(), slot);
        }

        let catalog = AgentModelCatalog {
            inner: Arc::new(StaticCatalog {
                rows: vec![ModelRow { provider: "openai".into(), id: "gpt-5".into(), display: "GPT-5".into(), catalog_complete: true, row: json!({}) }],
                own: None,
            }),
            agents: agents.clone(),
            settings: Arc::new(Map::new),
        };

        let err = tokio::time::timeout(std::time::Duration::from_secs(2), resolve_requested_model(&json!({ "model": "nonexistent-model" }), Some(&catalog)))
            .await
            .expect("must not wait in ensure_checked for ACP presets when no provider is given")
            .unwrap_err();
        assert!(err.contains("not found") && err.contains("openai/gpt-5"), "{err}");
        // Must not have started a check on the never-checked `antigravity-cli` preset either.
        assert!(lock(&agents.slots).get("antigravity-cli").is_none());
    }

    #[tokio::test]
    async fn agent_model_catalog_awaits_in_flight_acp_readiness_check_before_refusing() {
        use mixdog_agent::agent_tool::model_select::resolve_requested_model;
        use tokio::sync::watch;
        use tokio_util::sync::CancellationToken;

        use crate::upkeep::{Running, Step};

        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled);
        let (step_tx, _step_rx) = watch::channel(Step::Checking);
        let (done_tx, done_rx) = watch::channel(false);
        {
            let mut slots = lock(&agents.slots);
            let mut slot = Slot::default();
            slot.readiness = None;
            slot.running = Some(Running::for_test(step_tx, CancellationToken::new(), done_rx));
            slots.insert("antigravity".to_owned(), slot);
        }
        seed_slot(&agents, "antigravity-cli", Readiness::NotInstalled);

        let catalog = Arc::new(AgentModelCatalog { inner: Arc::new(EmptyCatalog), agents: agents.clone(), settings: Arc::new(Map::new) });
        let resolve = {
            let catalog = catalog.clone();
            tokio::spawn(async move { resolve_requested_model(&json!({ "provider": "acp-antigravity", "model": "gemini-4-neon" }), Some(&*catalog)).await })
        };
        tokio::task::yield_now().await;
        assert!(!resolve.is_finished(), "should wait for the in-flight check instead of refusing immediately");
        {
            let mut slots = lock(&agents.slots);
            let slot = slots.get_mut("antigravity").unwrap();
            slot.readiness = Some(Readiness::Ready { version: "1.5.2".into(), models: models(&[("gemini-4-neon", "Gemini 4 Neon")]) });
            slot.running = None;
        }
        let _ = done_tx.send(true);
        let (routed, note) = resolve.await.unwrap().unwrap();
        assert_eq!((routed["provider"].as_str(), routed["model"].as_str()), (Some("acp-antigravity"), Some("gemini-4-neon")));
        assert_eq!(note, "runs on acp-antigravity/gemini-4-neon");
    }

    struct ConfiguredFallbackFacts {
        fallback: DefaultSearchFallback,
    }

    #[async_trait]
    impl RouteFacts for ConfiguredFallbackFacts {
        fn is_known(&self, _: &str, _: &Map<String, Value>) -> bool {
            false
        }
        async fn ensure_ready(&self, _: &Map<String, Value>, provider: &str) -> Result<(), String> {
            Err(format!("unknown provider {provider}"))
        }
        fn model_meta(&self, _: &str, _: &str) -> Value {
            Value::Null
        }
        fn window_meta(&self, _: &str, _: &str, _: &Value) -> Option<Value> {
            None
        }
        fn catalog_knows(&self, _: &str, _: &str) -> bool {
            false
        }
        fn fast_capable(&self, _: &str, _: &Value, _: Option<&str>, _: &Value) -> bool {
            false
        }
        fn ultrafast_capable(&self, _: &str, _: &Value) -> bool {
            false
        }
        fn default_search_fallback(&self, _: &Map<String, Value>, _: &str, _: &str) -> DefaultSearchFallback {
            self.fallback.clone()
        }
    }

    struct FactsSearchHost {
        main: Value,
        stored: Value,
        facts: Arc<dyn RouteFacts>,
        ready_calls: std::sync::Mutex<Vec<String>>,
        fallback_calls: std::sync::atomic::AtomicUsize,
    }

    impl FactsSearchHost {
        fn new(main: Value, stored: Value, facts: Arc<dyn RouteFacts>) -> Arc<Self> {
            Arc::new(Self { main, stored, facts, ready_calls: std::sync::Mutex::new(Vec::new()), fallback_calls: std::sync::atomic::AtomicUsize::new(0) })
        }

        fn ready_calls(&self) -> Vec<String> {
            self.ready_calls.lock().unwrap().clone()
        }

        fn fallback_calls(&self) -> usize {
            self.fallback_calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl mixdog_tools::web::SearchHost for FactsSearchHost {
        fn main_route(&self, _: &ThreadId) -> Value {
            self.main.clone()
        }
        fn stored_web_search_route(&self) -> Value {
            self.stored.clone()
        }
        async fn main_model_row(&self, provider: &str, model: &str) -> Result<Option<Value>, String> {
            if !is_web_search_capable_provider(provider) {
                return Ok(None);
            }
            self.ready_calls.lock().unwrap().push(provider.to_owned());
            self.facts.ensure_ready(&Map::new(), provider).await?;
            Ok(self.facts.catalog_knows(model, provider).then(|| self.facts.model_meta(provider, model)))
        }
        fn catalog_row(&self, _: &str, _: &str) -> Option<Value> {
            None
        }
        async fn provider(&self, _: &str) -> Result<Option<mixdog_tools::web::SearchProvider>, String> {
            Ok(Some(mixdog_tools::web::SearchProvider::Acp))
        }
        fn session_id(&self, thread: &ThreadId) -> Option<String> {
            Some(thread.as_str().to_owned())
        }
        fn default_search_fallback(&self, main_provider: &str, main_model: &str) -> DefaultSearchFallback {
            self.fallback_calls.fetch_add(1, Ordering::SeqCst);
            self.facts.default_search_fallback(&Map::new(), main_provider, main_model)
        }
    }

    #[tokio::test]
    async fn default_web_search_on_cli_preset_picks_quick_model_on_official_preset_and_never_other_providers() {
        use mixdog_tools::web::{ConfiguredSearchRoutes, SearchFamily, SearchRoutes};

        for catalog in [
            &[
                ("gemini-pro-orchestrator", "Orchestrator"),
                ("gemini-3-pro", "Gemini 3 Pro"),
                ("gemini-2.5-flash", "Gemini 2.5 Flash"),
                ("gemini-3-flash", "Gemini 3 Flash"),
            ][..],
            &[
                ("gemini-3-flash", "Gemini 3 Flash"),
                ("gemini-2.5-flash", "Gemini 2.5 Flash"),
                ("gemini-3-pro", "Gemini 3 Pro"),
                ("gemini-pro-orchestrator", "Orchestrator"),
            ][..],
        ] {
            let enabled = Arc::new(AtomicBool::new(true));
            let (_dir, agents) = build_agents(builtin(), enabled);
            seed_slot(&agents, "antigravity", Readiness::Ready { version: "1.5.2".into(), models: models(catalog) });
            seed_slot(
                &agents,
                "antigravity-cli",
                Readiness::Ready { version: "1.5.16".into(), models: models(&[("claude-opus-4-6", "Claude Opus 4.6"), ("gpt-oss-120b", "GPT OSS 120B")]) },
            );

            let inner = Arc::new(ConfiguredFallbackFacts {
                fallback: DefaultSearchFallback { route: Some(DefaultSearchRoute { provider: "openai".into(), model: "gpt-5.2".into() }), reason: None },
            });
            let facts: Arc<dyn RouteFacts> = Arc::new(AgentRouteFacts { inner, agents });

            for model in ["claude-opus-4-6", "gpt-oss-120b"] {
                let host = FactsSearchHost::new(json!({ "provider": "acp-antigravity-cli", "model": model, "effort": "high" }), Value::Null, facts.clone());
                let routes = ConfiguredSearchRoutes::new(host.clone());
                let candidates = routes.candidates(&ThreadId::from("t-ready")).await.unwrap();
                let pairs: Vec<(&str, &str, SearchFamily)> = candidates.iter().map(|c| (c.provider.as_str(), c.model.as_str(), c.family)).collect();
                assert_eq!(
                    pairs,
                    [("acp-antigravity", "gemini-3-flash", SearchFamily::Acp)],
                    "{model}: must pick quick same-product Gemini model only and never another provider"
                );
                assert_eq!(candidates[0].effort, None, "Main model effort must not leak onto fallback route");
                assert_eq!(host.ready_calls(), vec!["acp-antigravity-cli".to_owned()]);
            }
        }
    }

    #[tokio::test]
    async fn user_written_fallbacks_come_before_automatic_acp_sibling_pick() {
        use mixdog_tools::web::{ConfiguredSearchRoutes, SearchFamily, SearchRoutes};

        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled);
        seed_slot(
            &agents,
            "antigravity",
            Readiness::Ready { version: "1.5.2".into(), models: models(&[("gemini-3-pro", "Gemini 3 Pro"), ("gemini-3-flash", "Gemini 3 Flash")]) },
        );
        seed_slot(&agents, "antigravity-cli", Readiness::Ready { version: "1.5.16".into(), models: models(&[("claude-opus-4-6", "Claude Opus 4.6")]) });

        let facts: Arc<dyn RouteFacts> = Arc::new(AgentRouteFacts { inner: Arc::new(EmptyFacts), agents });
        let host = FactsSearchHost::new(
            json!({ "provider": "acp-antigravity-cli", "model": "claude-opus-4-6" }),
            json!({
                "provider": "default",
                "model": "default",
                "fallbacks": [{ "provider": "openai", "model": "gpt-5.2" }]
            }),
            facts,
        );
        let routes = ConfiguredSearchRoutes::new(host);
        let candidates = routes.candidates(&ThreadId::from("t-user-first")).await.unwrap();
        let pairs: Vec<(&str, &str, SearchFamily)> = candidates.iter().map(|c| (c.provider.as_str(), c.model.as_str(), c.family)).collect();
        assert_eq!(pairs, [("openai", "gpt-5.2", SearchFamily::Openai), ("acp-antigravity", "gemini-3-flash", SearchFamily::Acp)]);
    }

    #[tokio::test]
    async fn default_web_search_on_cli_preset_with_official_preset_signed_out_does_not_pick_other_provider() {
        use mixdog_tools::web::{ConfiguredSearchRoutes, SearchFamily, SearchRoutes};

        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled);
        seed_slot(&agents, "antigravity", Readiness::SignedOut { version: "1.5.2".into(), message: "sign in".into() });
        seed_slot(&agents, "antigravity-cli", Readiness::Ready { version: "1.5.16".into(), models: models(&[("claude-opus-4-6", "Claude Opus 4.6")]) });

        let facts: Arc<dyn RouteFacts> = Arc::new(AgentRouteFacts {
            inner: Arc::new(ConfiguredFallbackFacts {
                fallback: DefaultSearchFallback { route: Some(DefaultSearchRoute { provider: "openai".into(), model: "gpt-5.2".into() }), reason: None },
            }),
            agents,
        });

        // No user fallbacks: never picks another provider automatically; resolve() builds the
        // unavailable message from one default_search_fallback call without retaining state.
        let host = FactsSearchHost::new(json!({ "provider": "acp-antigravity-cli", "model": "claude-opus-4-6" }), Value::Null, facts.clone());
        let routes = ConfiguredSearchRoutes::new(host.clone());
        let thread = ThreadId::from("t-signed-out-none");
        let message = match routes.resolve(&thread).await.unwrap() {
            mixdog_tools::web::SearchRouteResolution::Unavailable(message) => message,
            mixdog_tools::web::SearchRouteResolution::Candidates(c) => panic!("expected unavailable, got {c:?}"),
        };
        assert!(message.contains("acp-antigravity-cli/claude-opus-4-6"), "{message}");
        assert!(message.contains("Antigravity (acp-antigravity) is signed out"), "{message}");
        assert!(message.contains("sign in to Antigravity (acp-antigravity)"), "{message}");
        assert_eq!(host.fallback_calls(), 1, "one search resolve must call default_search_fallback once");

        // User-written fallback still runs even when official preset is signed out.
        let host = FactsSearchHost::new(
            json!({ "provider": "acp-antigravity-cli", "model": "claude-opus-4-6" }),
            json!({
                "provider": "default",
                "model": "default",
                "fallbacks": [{ "provider": "openai", "model": "gpt-5.2" }]
            }),
            facts,
        );
        let routes = ConfiguredSearchRoutes::new(host);
        let candidates = routes.candidates(&ThreadId::from("t-signed-out-user-fallback")).await.unwrap();
        let pairs: Vec<(&str, &str, SearchFamily)> = candidates.iter().map(|c| (c.provider.as_str(), c.model.as_str(), c.family)).collect();
        assert_eq!(pairs, [("openai", "gpt-5.2", SearchFamily::Openai)]);
    }

    #[tokio::test]
    async fn default_web_search_on_cli_preset_with_official_preset_absent_does_not_pick_other_provider() {
        use mixdog_tools::web::{ConfiguredSearchRoutes, SearchFamily, SearchRoutes};

        let cli_only: Vec<AgentPreset> = builtin().into_iter().filter(|preset| preset.id == "antigravity-cli").collect();
        assert_eq!(cli_only.len(), 1);
        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(cli_only, enabled);
        seed_slot(&agents, "antigravity-cli", Readiness::Ready { version: "1.5.16".into(), models: models(&[("claude-opus-4-6", "Claude Opus 4.6")]) });

        let facts: Arc<dyn RouteFacts> = Arc::new(AgentRouteFacts {
            inner: Arc::new(ConfiguredFallbackFacts {
                fallback: DefaultSearchFallback {
                    route: Some(DefaultSearchRoute { provider: "gemini".into(), model: "gemini-2.5-flash".into() }),
                    reason: None,
                },
            }),
            agents,
        });

        let host = FactsSearchHost::new(json!({ "provider": "acp-antigravity-cli", "model": "claude-opus-4-6" }), Value::Null, facts.clone());
        let routes = ConfiguredSearchRoutes::new(host);
        let thread = ThreadId::from("t-absent-none");
        assert!(routes.candidates(&thread).await.unwrap().is_empty());
        let message = routes.no_candidate_message(&thread).await;
        assert!(message.contains("acp-antigravity-cli/claude-opus-4-6"), "{message}");
        assert!(message.contains("no search-capable"), "{message}");
        assert!(!message.contains("sign in"), "{message}");
        assert!(!message.contains("acp-antigravity)"), "{message}");

        // User-written fallback still works when official preset is absent.
        let host = FactsSearchHost::new(
            json!({ "provider": "acp-antigravity-cli", "model": "claude-opus-4-6" }),
            json!({
                "provider": "default",
                "model": "default",
                "fallbacks": [{ "provider": "gemini", "model": "gemini-2.5-flash" }]
            }),
            facts,
        );
        let routes = ConfiguredSearchRoutes::new(host);
        let candidates = routes.candidates(&ThreadId::from("t-absent-user-fallback")).await.unwrap();
        let pairs: Vec<(&str, &str, SearchFamily)> = candidates.iter().map(|c| (c.provider.as_str(), c.model.as_str(), c.family)).collect();
        assert_eq!(pairs, [("gemini", "gemini-2.5-flash", SearchFamily::Gemini)]);
    }

    #[tokio::test]
    async fn default_web_search_failure_messages_state_real_cause_without_probing_sibling() {
        use mixdog_tools::web::{ConfiguredSearchRoutes, SearchRoutes};
        use tokio::sync::watch;
        use tokio_util::sync::CancellationToken;

        use crate::upkeep::{Running, Step};

        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled.clone());
        seed_slot(&agents, "antigravity-cli", Readiness::Ready { version: "1.5.16".into(), models: models(&[("claude-opus-4-6", "Claude Opus 4.6")]) });
        let facts: Arc<dyn RouteFacts> = Arc::new(AgentRouteFacts { inner: Arc::new(EmptyFacts), agents: agents.clone() });
        let run_msg = |tag: &str| {
            let facts = facts.clone();
            let thread = ThreadId::from(tag);
            async move {
                let host = FactsSearchHost::new(json!({ "provider": "acp-antigravity-cli", "model": "claude-opus-4-6" }), Value::Null, facts);
                let routes = ConfiguredSearchRoutes::new(host);
                assert!(routes.candidates(&thread).await.unwrap().is_empty());
                routes.no_candidate_message(&thread).await
            }
        };

        // Unchecked while ACP enabled: must not say "enable ACP agents" and must not start a probe.
        let unchecked = run_msg("t-unchecked").await;
        assert!(unchecked.contains("has not finished checking yet"), "{unchecked}");
        assert!(!unchecked.contains("enable ACP agents"), "{unchecked}");
        assert!(lock(&agents.slots).get("antigravity").is_none(), "fallback check must not spawn a sibling readiness probe");

        // Updating: must say updating, not sign in.
        let (step_tx, _step_rx) = watch::channel(Step::Updating);
        let (_done_tx, done_rx) = watch::channel(false);
        {
            let mut slots = lock(&agents.slots);
            let mut slot = Slot::default();
            slot.readiness = Some(Readiness::VersionTooOld { version: "1.0.0".into() });
            slot.running = Some(Running::for_test(step_tx, CancellationToken::new(), done_rx));
            slots.insert("antigravity".to_owned(), slot);
        }
        let updating = run_msg("t-updating").await;
        assert!(updating.contains("is updating"), "{updating}");
        assert!(!updating.contains("sign in"), "{updating}");

        // Failed: must state failure cause, not sign in.
        seed_slot(&agents, "antigravity", Readiness::Failed { version: None, message: "launch crashed".into() });
        let failed = run_msg("t-failed").await;
        assert!(failed.contains("did not start: launch crashed"), "{failed}");
        assert!(!failed.contains("sign in"), "{failed}");

        // Ready but account refused: program started, so must say account was refused, not "did not start".
        seed_slot(&agents, "antigravity", Readiness::Ready { version: "1.5.2".into(), models: models(&[("gemini-3-flash", "Gemini 3 Flash")]) });
        let official = agents.preset_of_route("acp-antigravity").unwrap().clone();
        agents.refused(&official, "account suspended").await;
        let refused = run_msg("t-refused").await;
        assert!(refused.contains("refused the signed-in account: account suspended"), "{refused}");
        assert!(!refused.contains("did not start"), "{refused}");
        agents.answered(&official).await;

        // Ready with no search-capable model: must say no web-search-capable model, not sign in.
        seed_slot(&agents, "antigravity", Readiness::Ready { version: "1.5.2".into(), models: models(&[("gemini-pro-orchestrator", "Orchestrator")]) });
        let no_model = run_msg("t-no-model").await;
        assert!(no_model.contains("offers no web-search-capable model"), "{no_model}");
        assert!(!no_model.contains("sign in"), "{no_model}");

        // ACP disabled: the Main route's own readiness refuses the lookup saying ACP agents are turned off, and the
        // message without it says so too.
        enabled.store(false, Ordering::SeqCst);
        let host = FactsSearchHost::new(json!({ "provider": "acp-antigravity-cli", "model": "claude-opus-4-6" }), Value::Null, facts.clone());
        let routes = ConfiguredSearchRoutes::new(host);
        let thread = ThreadId::from("t-off");
        let refused = routes.candidates(&thread).await.unwrap_err();
        assert!(refused.contains("ACP agents are turned off"), "{refused}");
        let off = routes.no_candidate_message(&thread).await;
        assert!(off.contains("ACP agents are turned off"), "{off}");
    }

    #[tokio::test]
    async fn explicit_web_search_route_and_usable_main_add_no_readiness_work() {
        use mixdog_tools::web::{ConfiguredSearchRoutes, SearchFamily, SearchRoutes};

        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled);
        seed_slot(&agents, "antigravity", Readiness::Ready { version: "1.5.2".into(), models: models(&[("gemini-3-flash", "Gemini 3 Flash")]) });
        // Leave `antigravity-cli` completely unchecked to verify it is never probed.
        let facts: Arc<dyn RouteFacts> = Arc::new(AgentRouteFacts {
            inner: Arc::new(ConfiguredFallbackFacts {
                fallback: DefaultSearchFallback { route: Some(DefaultSearchRoute { provider: "openai".into(), model: "gpt-5.2".into() }), reason: None },
            }),
            agents: agents.clone(),
        });

        // Usable Main route: zero fallback lookups, zero sibling probes.
        let host = FactsSearchHost::new(json!({ "provider": "acp-antigravity", "model": "gemini-3-flash" }), Value::Null, facts.clone());
        let routes = ConfiguredSearchRoutes::new(host.clone());
        let candidates = routes.candidates(&ThreadId::from("t-usable-main")).await.unwrap();
        let pairs: Vec<(&str, &str, SearchFamily)> = candidates.iter().map(|c| (c.provider.as_str(), c.model.as_str(), c.family)).collect();
        assert_eq!(pairs, [("acp-antigravity", "gemini-3-flash", SearchFamily::Acp)]);
        assert_eq!(host.fallback_calls(), 0);
        assert!(lock(&agents.slots).get("antigravity-cli").is_none());

        // Explicit webSearchRoute on CLI Main: used strictly as set with zero readiness or fallback calls.
        seed_slot(&agents, "antigravity-cli", Readiness::Ready { version: "1.5.16".into(), models: models(&[("claude-opus-4-6", "Claude Opus 4.6")]) });
        for (stored, want) in [
            (json!({ "provider": "anthropic", "model": "claude-sonnet-4-5" }), ("anthropic", "claude-sonnet-4-5", SearchFamily::Anthropic)),
            (json!({ "provider": "acp-antigravity", "model": "gemini-3-pro" }), ("acp-antigravity", "gemini-3-pro", SearchFamily::Acp)),
        ] {
            let host = FactsSearchHost::new(json!({ "provider": "acp-antigravity-cli", "model": "claude-opus-4-6" }), stored, facts.clone());
            let routes = ConfiguredSearchRoutes::new(host.clone());
            let candidates = routes.candidates(&ThreadId::from("t-explicit")).await.unwrap();
            let pairs: Vec<(&str, &str, SearchFamily)> = candidates.iter().map(|c| (c.provider.as_str(), c.model.as_str(), c.family)).collect();
            assert_eq!(pairs, [want]);
            assert!(host.ready_calls().is_empty(), "explicit route must not call ensure_ready");
            assert_eq!(host.fallback_calls(), 0, "explicit route must not call default_search_fallback");
        }
    }
}
