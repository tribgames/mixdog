use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::one_shot::{CallShape, OneShot, OneShotCall, PromptCache};
use mixdog_agent::tools::ToolEnv;
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::agent_disabled;
use mixdog_core_session::session::session_title::{TitleError, TitleModel};
use mixdog_protocol::TurnId;
use mixdog_rt::CancellationToken;
use serde_json::{Map, Value, json};

use crate::run_host::retry::{RandomJitter, TimerWait};
use crate::run_host::session_cache_opts::call_cache_opts;
use crate::run_host::summary_host::{NoApprovals, SummaryDeps};
use mixdog_core_ports::ports::route_facts::RouteSender;

const MAINTAINER_ROLE: &str = "maintainer";
const TITLE_AGENT: &str = "title-agent";
const TITLE_SYSTEM_PROMPT: &str = "Create a concise, natural session title of 3-7 words that captures the main topic or goal of the provided message or conversation. Output only one title on one line, at most 32 characters; no quotes, markdown, or trailing period.";
/// The title request's output cap.
const MAX_OUTPUT_TOKENS: u32 = 128;

/// `titleSystemPrompt(locale)`.
fn system_prompt(locale: &str) -> String {
    let locale = mixdog_js::js_trim(locale);
    if locale.is_empty() {
        return TITLE_SYSTEM_PROMPT.to_owned();
    }
    format!(
        "{TITLE_SYSTEM_PROMPT} System language/locale: {locale}. Prefer that language when the source is ambiguous; preserve a clearly different source language."
    )
}

/// `String(value || '').trim()`.
fn trimmed(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => String::new(),
        Some(Value::String(text)) => mixdog_js::js_trim(text).to_owned(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => String::new(),
        Some(other) => mixdog_js::js_trim(&mixdog_js::value_to_string(other)).to_owned(),
    }
}

/// What the maintenance route resolved to.
#[derive(Debug, PartialEq)]
enum Route {
    /// `null`: no route.
    None,
    /// An array candidate passes through unnormalized and has no provider or model.
    Incomplete,
    Complete {
        provider: String,
        model: String,
        effort: String,
        fast: bool,
    },
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `normalizeMaintenanceCandidate`, then the route checks of `generateSessionTitle`. A candidate that names a preset is
/// that preset's route, as the config's every other route reader takes it.
fn candidate_route(config: &Map<String, Value>, candidate: &Value) -> Option<Route> {
    if !truthy(candidate) {
        return None;
    }
    match candidate {
        Value::Array(_) => Some(Route::Incomplete),
        Value::Object(route) => {
            let (provider, model) = (trimmed(route.get("provider")), trimmed(route.get("model")));
            if provider.is_empty() || model.is_empty() {
                return None;
            }
            Some(Route::Complete { provider, model, effort: trimmed(route.get("effort")), fast: route.get("fast") == Some(&Value::Bool(true)) })
        }
        named => mixdog_core_config::config::agent_routes::route_of(config, named).filter(Value::is_object).and_then(|route| candidate_route(config, &route)),
    }
}

/// `resolveMaintenanceRoute({ agent: 'title-agent', config })`: a disabled Maintainer has none;
/// else the first usable of its stored route and the config's default.
fn title_route(config: &Map<String, Value>) -> Route {
    if agent_disabled(config, MAINTAINER_ROLE) {
        return Route::None;
    }
    let stored = config.get("agents").and_then(Value::as_object).and_then(|agents| agents.get(MAINTAINER_ROLE)).filter(|route| truthy(route));
    stored.into_iter().chain(config.get("default")).find_map(|candidate| candidate_route(config, candidate)).unwrap_or(Route::None)
}

fn title_tool_env(deps: &SummaryDeps, session_id: &str) -> ToolEnv {
    ToolEnv {
        thread_id: ThreadId::from(session_id),
        turn_id: TurnId::from("title"),
        cwd: deps.data_dir.clone(),
        surface: mixdog_core_api::domain::tool::SurfaceKind::Lead,
        io: deps.io,
        approvals: Arc::new(NoApprovals(deps.clock.clone())),
        files: deps.files.clone(),
        processes: deps.processes.clone(),
        progress: deps.progress.clone(),
        deadline_of: None,
        notify: None,
        review: None,
    }
}

/// The wire `provider` sends a tool-less call to `model` on (`sendWireRoute` with no pin); `None` for a provider of one wire.
async fn call_wire(provider: &dyn mixdog_core_api::domain::provider::ProviderAdapter, model: &str) -> Option<String> {
    let context = mixdog_core_api::domain::provider::WireRouteContext::default();
    provider.wire_routing()?.resolve_wire_route(model, &context).await.ok()?.map(|route| route.wire)
}

fn title_options(provider_name: &str, model: &str, wire: Option<&str>, session_id: &str) -> RequestOptions {
    let cache = call_cache_opts(provider_name, model, wire, Some(TITLE_AGENT), &json!({}));
    let scope = cache.as_ref().and_then(|c| c.get("promptCacheScope")).and_then(Value::as_str).map(str::to_owned);
    let strategy = cache.as_ref().and_then(|c| c.get("cacheStrategy")).cloned();
    RequestOptions {
        usage_session_id: Some(session_id.to_owned()).filter(|id| !id.is_empty()),
        source_type: Some("session-title".to_owned()),
        prompt_cache_scope: scope,
        model_parameters: strategy.map(|strategy| json!({ "cacheStrategy": strategy })),
        ..RequestOptions::default()
    }
}

/// The title model over the process's providers; a route on an agent is served by that agent, as a summary on it is.
pub struct TitleCompletion {
    deps: Arc<SummaryDeps>,
}

impl TitleCompletion {
    pub(crate) fn new(deps: Arc<SummaryDeps>) -> Self {
        Self { deps }
    }
}

#[async_trait]
impl TitleModel for TitleCompletion {
    fn routed(&self) -> bool {
        title_route(&(self.deps.config)()) != Route::None
    }

    async fn generate(&self, source: &str, session_id: &str, locale: &str, cancel: &CancellationToken) -> Result<String, TitleError> {
        let text = mixdog_js::js_trim(source);
        if text.is_empty() {
            return Ok(String::new());
        }
        let deps = &self.deps;
        let config = (deps.config)();
        let (provider_name, model, effort, fast) = match title_route(&config) {
            Route::None => return Err(TitleError::RouteUnresolved),
            Route::Incomplete => return Err(TitleError::Failed("Error: Session title maintenance route requires provider and model.".into())),
            Route::Complete { provider, model, effort, fast } => (provider, model, effort, fast),
        };
        let providers = config.get("providers").and_then(Value::as_object).cloned().unwrap_or_default();
        let provider = match deps.facts.sender(Some(&providers), &provider_name).await.map_err(TitleError::Failed)? {
            Some(RouteSender::Provider(provider)) => provider,
            Some(RouteSender::Agent(agent)) => {
                let answer = agent.ask(&model, &system_prompt(locale), text).await.map_err(|error| TitleError::Failed(format!("Error: {error}")))?;
                return Ok(mixdog_js::js_trim(&answer.text).to_owned());
            }
            None => return Err(TitleError::Failed(format!("Error: Session title provider is unavailable: {provider_name}"))),
        };
        let tool_env = title_tool_env(deps, session_id);
        let wire = call_wire(&*provider, &model).await;
        let options = title_options(&provider_name, &model, wire.as_deref(), session_id);
        let one_shot = OneShot::standalone(
            deps.clock.clone(),
            Arc::new(RandomJitter),
            Arc::new(TimerWait),
            Arc::new(StandardRetryDecider),
            tool_env,
            provider,
            cancel.clone(),
        )
        .with_options(options);
        let call = OneShotCall {
            model,
            max_output_tokens: Some(MAX_OUTPUT_TOKENS),
            fast,
            // A background call: an overloaded provider is not retried.
            shape: CallShape {
                request_kind: None,
                effort: if effort.is_empty() { "low".to_owned() } else { effort },
                retry_529: false,
                prompt_cache: PromptCache::Route,
            },
        };
        let out = one_shot.call_prompt(&call, &system_prompt(locale), text).await.map_err(|error| TitleError::Failed(error.to_string()))?;
        Ok(mixdog_js::js_trim(&out.text).to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_spend_is_booked_to_the_titled_session_as_a_title_call() {
        let options = title_options("openai", "gpt-x", None, "sess_1");
        assert_eq!((options.usage_session_id.as_deref(), options.source_type.as_deref()), (Some("sess_1"), Some("session-title")));
        assert_eq!(title_options("openai", "gpt-x", None, "").usage_session_id, None);
    }

    /// A title on Claude through OpenRouter's Messages wire or on Vertex AI takes the one-shot policy of the direct route:
    /// system and tools at an hour, no message tail; on OpenRouter's Chat wire it states none.
    #[test]
    fn a_title_on_a_breakpoint_route_takes_the_one_shot_policy_of_the_direct_route() {
        let direct = title_options("anthropic-oauth", "claude-haiku-4-5", None, "sess_1").model_parameters;
        assert_eq!(direct, Some(json!({ "cacheStrategy": { "tools": "none", "system": "1h", "tier3": "1h", "messages": "none" } })));
        assert_eq!(title_options("openrouter", "anthropic/claude-haiku-4.5", Some("messages"), "sess_1").model_parameters, direct);
        assert_eq!(title_options("vertex-ai", "claude-haiku-4-5", None, "sess_1").model_parameters, direct);
        assert_eq!(title_options("openrouter", "anthropic/claude-haiku-4.5", Some("chat"), "sess_1").model_parameters, None);
    }

    fn config(value: Value) -> Map<String, Value> {
        mixdog_core_config::config::agent_routes::stored_file_of(&value)["agent"].as_object().unwrap().clone()
    }

    #[test]
    fn the_title_route_is_the_maintainers_stored_route_else_the_default() {
        let stored = json!({ "provider": " openai ", "model": "gpt-x", "effort": " high ", "fast": true });
        let complete = |provider: &str, model: &str, effort: &str, fast: bool| Route::Complete {
            provider: provider.into(),
            model: model.into(),
            effort: effort.into(),
            fast,
        };
        assert_eq!(title_route(&config(json!({}))), Route::None);
        assert_eq!(title_route(&config(json!({ "agents": { "maintainer": stored } }))), complete("openai", "gpt-x", "high", true));
        assert_eq!(
            title_route(&config(json!({ "agents": { "maintainer": { "provider": "x" } }, "default": { "provider": "anthropic", "model": "haiku" } }))),
            complete("anthropic", "haiku", "", false)
        );
        assert_eq!(title_route(&config(json!({ "default": { "provider": "anthropic", "model": " " } }))), Route::None);
        assert_eq!(title_route(&config(json!({ "default": "no-such-preset" }))), Route::None);
        assert_eq!(title_route(&config(json!({ "default": [1] }))), Route::Incomplete);
    }

    #[test]
    fn a_title_route_that_names_a_preset_is_that_presets_route() {
        let presets = json!([
            { "id": "main", "name": "main", "provider": "anthropic", "model": "claude-x" },
            { "id": "light", "name": "light", "provider": "openai", "model": "gpt-mini" },
        ]);
        let provider_model = |route: Route| match route {
            Route::Complete { provider, model, .. } => Some((provider, model)),
            _ => None,
        };
        let by_default = title_route(&config(json!({ "presets": presets, "default": "main" })));
        assert_eq!(provider_model(by_default), Some(("anthropic".to_owned(), "claude-x".to_owned())));
        let by_maintainer = title_route(&config(json!({ "presets": presets, "default": "main", "agents": { "maintainer": "light" } })));
        assert_eq!(provider_model(by_maintainer), Some(("openai".to_owned(), "gpt-mini".to_owned())));
    }
}
