//! A route on an agent, for every reader of a route: the agent is no provider of the catalog or the registry, so what
//! those readers ask of a route's provider is answered here for an agent's route.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
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
                self.agents.ready_program(preset).await.map(drop).map_err(|refusal| refusal.message(preset))?;
                self.agents.selectable(preset).map_err(|refusal| refusal.message(preset))
            }
            None => self.inner.ensure_ready(config, provider).await,
        }
    }

    fn model_meta(&self, provider: &str, model: &str) -> Value {
        match self.agents.preset_of_route(provider) {
            Some(preset) => self.agents.model_row(preset, model),
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
    /// as a turn on it is.
    async fn sender(&self, providers: Option<&Map<String, Value>>, provider: &str) -> Result<Option<RouteSender>, String> {
        match self.agents.preset_of_route(provider) {
            Some(preset) => Ok(Some(RouteSender::Agent(Arc::new(AgentQuestion { agents: self.agents.clone(), preset: preset.clone() })))),
            None => self.inner.sender(providers, provider).await,
        }
    }

    fn registered(&self, provider: &str) -> Option<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>> {
        self.agents.preset_of_route(provider).is_none().then(|| self.inner.registered(provider)).flatten()
    }

    fn init_error(&self, provider: &str) -> Option<String> {
        self.agents.preset_of_route(provider).is_none().then(|| self.inner.init_error(provider)).flatten()
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

/// [`RouteWriter`] for a session that may be on an agent's route: leaving the agent's route ends the agent's process,
/// and an agent's route has no provider usage to read.
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

    /// A session that leaves an agent's route has no use for the agent's process from that moment: it is ended here,
    /// not at the session's next turn, which may never come.
    fn set_route_state(&self, thread: &ThreadId, route: Route) {
        if !self.on_agent(&route) {
            self.agents.end_process(thread);
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
        for row in &mut rows {
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
