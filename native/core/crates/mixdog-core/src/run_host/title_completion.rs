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
use crate::run_host::session_cache_opts::session_provider_cache_opts;
use crate::run_host::summary_host::{NoApprovals, SummaryDeps};

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
    /// A truthy candidate that is no object (a preset name): `typeof route !== 'object'`.
    NotAnObject,
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

/// `normalizeMaintenanceCandidate`, then the route checks of `generateSessionTitle`.
fn candidate_route(candidate: &Value) -> Option<Route> {
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
        _ => Some(Route::NotAnObject),
    }
}

/// `resolveMaintenanceRoute({ agent: 'title-agent', config })`: a disabled Maintainer has none;
/// else the first usable of its stored route and the config's default.
fn title_route(config: &Map<String, Value>) -> Route {
    if agent_disabled(config, MAINTAINER_ROLE) {
        return Route::None;
    }
    let stored = config.get("agents").and_then(Value::as_object).and_then(|agents| agents.get(MAINTAINER_ROLE)).filter(|route| truthy(route));
    stored.into_iter().chain(config.get("default")).find_map(candidate_route).unwrap_or(Route::None)
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

fn title_options(provider_name: &str, session_id: &str) -> RequestOptions {
    let cache = session_provider_cache_opts(provider_name, Some(TITLE_AGENT), &json!({}));
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

/// The title model over the process's providers.
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
    async fn generate(&self, source: &str, session_id: &str, locale: &str, cancel: &CancellationToken) -> Result<String, TitleError> {
        let text = mixdog_js::js_trim(source);
        if text.is_empty() {
            return Ok(String::new());
        }
        let deps = &self.deps;
        let config = (deps.config)();
        let (provider_name, model, effort, fast) = match title_route(&config) {
            Route::None | Route::NotAnObject => return Err(TitleError::RouteUnresolved),
            Route::Incomplete => return Err(TitleError::Failed("Error: Session title maintenance route requires provider and model.".into())),
            Route::Complete { provider, model, effort, fast } => (provider, model, effort, fast),
        };
        let providers = config.get("providers").and_then(Value::as_object).cloned().unwrap_or_default();
        deps.registry.init_providers(&providers).await.map_err(|error| TitleError::Failed(error.message))?;
        let Some(provider) = deps.registry.get(&provider_name).await else {
            return Err(TitleError::Failed(format!("Error: Session title provider is unavailable: {provider_name}")));
        };
        let tool_env = title_tool_env(deps, session_id);
        let options = title_options(&provider_name, session_id);
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
        let options = title_options("openai", "sess_1");
        assert_eq!((options.usage_session_id.as_deref(), options.source_type.as_deref()), (Some("sess_1"), Some("session-title")));
        assert_eq!(title_options("openai", "").usage_session_id, None);
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
        assert_eq!(title_route(&config(json!({ "default": "preset" }))), Route::NotAnObject);
        assert_eq!(title_route(&config(json!({ "default": [1] }))), Route::Incomplete);
    }
}
