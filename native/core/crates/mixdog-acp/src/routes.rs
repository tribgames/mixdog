//! A route on an agent, for every reader of a route: the agent is no provider of the catalog or the registry, so what
//! those readers ask of a route's provider is answered here for an agent's route.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::routes::web_search_capable_for;
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

fn web_search_capable(agents: &Arc<Agents>, preset: &AgentPreset, model: &str) -> bool {
    let model = model.trim();
    agents.selectable(preset).is_ok()
        && web_search_capable_for(&preset.provider, model, None, None)
        && agents.refuses_model(preset, model).is_none()
        && !is_own_orchestration(preset, model)
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

    async fn ensure_route_ready(&self, config: &Map<String, Value>, provider: &str, model: &str) -> Result<(), String> {
        match self.agents.preset_of_route(provider) {
            Some(preset) => {
                let model = if model.is_empty() { crate::agents::DEFAULT_MODEL } else { model };
                if let Some(why) = self.agents.refuses_model(preset, model) {
                    return Err(why);
                }
                self.ensure_ready(config, provider).await
            }
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
            models.retain(|row| {
                row.get("provider").and_then(Value::as_str).is_none_or(|provider| self.agents.preset_of_route(provider).is_none())
            });
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
        let processes = Arc::new(mixdog_spawn::LocalProcessManager::new(
            mixdog_rt::testing::tokens().spawn_io,
            mixdog_spawn::ProcessConfig::default(),
        ));
        let agents = Agents::new(AgentsParts {
            refusals: Arc::new(NoRefusals),
            presets,
            processes,
            files: Arc::new(NoFiles),
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
            Readiness::Ready {
                version: "1.5.2".into(),
                models: models(&[("gemini-3-flash", "Gemini 3 Flash"), ("gemini-pro-orchestrator", "Orchestrator")]),
            },
        );
        seed_slot(
            &agents,
            "antigravity-cli",
            Readiness::SignedOut { version: "1.5.16".into(), message: "sign in".into() },
        );

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

        seed_slot(
            &agents,
            "antigravity-cli",
            Readiness::Ready { version: "1.5.16".into(), models: models(&[("claude-opus-4-6", "Claude Opus 4.6")]) },
        );
        assert_eq!(facts.model_meta("acp-antigravity-cli", "claude-opus-4-6")["supportsWebSearch"], json!(true));
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
            Readiness::Ready {
                version: "1.5.2".into(),
                models: models(&[("gemini-3-flash", "Gemini 3 Flash"), ("gemini-embedding-001", "Gemini Embedding")]),
            },
        );
        seed_slot(
            &agents,
            "antigravity-cli",
            Readiness::Ready {
                version: "1.5.16".into(),
                models: models(&[
                    ("claude-opus-4-6", "Claude Opus 4.6"),
                    ("text-embedding-001", "Text Embedding"),
                    ("whisper-1", "Whisper"),
                ]),
            },
        );

        let facts = AgentRouteFacts { inner: Arc::new(EmptyFacts), agents: agents.clone() };
        for (provider, id) in [
            ("acp-antigravity", "gemini-embedding-001"),
            ("acp-antigravity-cli", "text-embedding-001"),
            ("acp-antigravity-cli", "whisper-1"),
        ] {
            let meta = facts.model_meta(provider, id);
            assert_eq!(meta["supportsWebSearch"], json!(false), "{provider}/{id}");
            assert!(!web_search_capable_for(provider, id, Some(&meta), None), "{provider}/{id} must not pass web_search_capable_for");
        }

        let decorator = AgentWebSearchModels {
            inner: Arc::new(StaticWebSearchModels(json!([]))),
            agents,
            settings: Arc::new(Map::new),
        };
        let listed = decorator.list(None, false).await.unwrap();
        let pairs: Vec<(&str, &str)> = listed.as_array().unwrap().iter().map(|r| (r["provider"].as_str().unwrap(), r["id"].as_str().unwrap())).collect();
        assert_eq!(pairs, [("acp-antigravity", "gemini-3-flash"), ("acp-antigravity-cli", "claude-opus-4-6")]);
    }

    #[tokio::test]
    async fn unready_or_disabled_acp_agent_emits_no_web_search_rows() {
        let enabled = Arc::new(AtomicBool::new(true));
        let (_dir, agents) = build_agents(builtin(), enabled.clone());
        seed_slot(&agents, "antigravity", Readiness::SignedOut { version: "1.5.2".into(), message: "sign in".into() });
        seed_slot(
            &agents,
            "antigravity-cli",
            Readiness::Ready { version: "1.5.16".into(), models: models(&[("claude-opus-4-6", "Claude Opus 4.6")]) },
        );

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
        assert_eq!(pairs, [("openai", "gpt-5.2"), ("acp-antigravity-cli", "claude-opus-4-6")]);
        assert_eq!(listed.as_array().unwrap()[1]["runner"], "acp");

        enabled.store(false, Ordering::SeqCst);
        let listed = decorator.list(None, false).await.unwrap();
        let pairs: Vec<(&str, &str)> = listed.as_array().unwrap().iter().map(|r| (r["provider"].as_str().unwrap(), r["id"].as_str().unwrap())).collect();
        assert_eq!(pairs, [("openai", "gpt-5.2")]);
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
            Readiness::Ready {
                version: "1.5.16".into(),
                models: models(&[("claude-opus-4-6", "Claude Opus 4.6"), ("gemini-3-flash", "Gemini 3 Flash")]),
            },
        );
        seed_slot(
            &agents,
            "non-search",
            Readiness::Ready { version: "1.0.0".into(), models: models(&[("gemini-3-flash", "Gemini 3 Flash")]) },
        );

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
        let decorator = AgentWebSearchModels {
            inner,
            agents,
            settings: Arc::new(move || saved.as_object().cloned().unwrap_or_default()),
        };

        let listed = decorator.list(None, false).await.unwrap();
        let rows = listed.as_array().unwrap();
        let pairs: Vec<(&str, &str)> = rows.iter().map(|r| (r["provider"].as_str().unwrap(), r["id"].as_str().unwrap())).collect();
        assert_eq!(
            pairs,
            [
                ("default", "default"),
                ("openai", "gpt-5.2"),
                ("acp-antigravity", "gemini-3-flash"),
                ("acp-antigravity", "gemini-3-pro"),
                ("acp-antigravity-cli", "claude-opus-4-6"),
            ]
        );
        let flash = rows.iter().find(|r| r["provider"] == "acp-antigravity" && r["id"] == "gemini-3-flash").unwrap();
        assert_eq!(flash["runner"], "acp");
        assert_eq!(flash["supportsWebSearch"], true);
        assert_eq!(flash["webSearchCapable"], true);
        assert_eq!(flash["webSearchToolType"], "web_search");
        assert_eq!(flash["favorite"], true);

        let pro = rows.iter().find(|r| r["provider"] == "acp-antigravity" && r["id"] == "gemini-3-pro").unwrap();
        assert_eq!(pro["savedEffort"], "high");

        let claude = rows.iter().find(|r| r["provider"] == "acp-antigravity-cli" && r["id"] == "claude-opus-4-6").unwrap();
        assert_eq!(claude["savedHidden"], true);
    }
}
