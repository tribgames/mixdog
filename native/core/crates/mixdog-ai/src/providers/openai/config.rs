//! Route, model facts and the injected runtime context of the OpenAI
//! Responses codecs. The codecs are pure: every value that comes from the
//! clock, the credential store or a random source is read through
//! [`WireContext`], and every model capability through [`ModelFactsSource`].

use std::sync::Arc;

use serde_json::Value;

/// The `providerReplay` owner shared by both OpenAI routes: one Responses
/// wire family, so a reasoning item produced on one route replays on the other.
pub const REPLAY_OWNER: &str = "openai-responses";

/// Which backend a codec talks to.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Route {
    /// Public API with an API key (`openai`).
    ApiKey,
    /// ChatGPT / Codex backend with a subscription token (`openai-oauth`).
    Codex,
}

impl Route {
    pub const fn http_url(self) -> &'static str {
        match self {
            Self::ApiKey => "https://api.openai.com/v1/responses",
            Self::Codex => "https://chatgpt.com/backend-api/codex/responses",
        }
    }

    pub const fn ws_url(self) -> &'static str {
        match self {
            Self::ApiKey => "wss://api.openai.com/v1/responses",
            Self::Codex => "wss://chatgpt.com/backend-api/codex/responses",
        }
    }
}

/// How a model on the public API takes its prompt-cache lifetime.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum PromptCacheLifetime {
    /// The model takes no lifetime field.
    #[default]
    None,
    /// `prompt_cache_options: {ttl: "30m"}`.
    Options30m,
    /// `prompt_cache_retention: "24h"`.
    Retention24h,
}

/// What the catalog says about one model. `None` means the catalog is silent:
/// the public API then sends nothing optional for that capability, while the
/// Codex backend keeps its defaults.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct ModelFacts {
    pub reasoning: Option<bool>,
    pub reasoning_summaries: Option<bool>,
    pub verbosity: Option<bool>,
    pub native_tool_search: Option<bool>,
    /// The public API's fast tiers (`openAiDirectSupportsFast`, `openAiDirectSupportsUltrafast`).
    pub fast_tier: bool,
    pub ultrafast_tier: bool,
    /// The Codex route's: what the cached Codex catalog row offers (`codexModelSupportsServiceTier`,
    /// `model-service-tiers.mjs`), never the model id.
    pub codex_fast_tier: bool,
    pub codex_ultrafast_tier: bool,
    pub prompt_cache: PromptCacheLifetime,
    /// Codex route only: the catalog's `access_programs` value for the model.
    pub access_programs: Option<Value>,
}

pub trait ModelFactsSource: Send + Sync {
    fn facts(&self, model: &str) -> ModelFacts;
}

/// A catalog with no rows: every model is unknown.
pub struct NoFacts;

impl ModelFactsSource for NoFacts {
    fn facts(&self, _model: &str) -> ModelFacts {
        ModelFacts::default()
    }
}

/// Values the codec cannot derive from the request.
pub trait WireContext: Send + Sync {
    /// A fresh 32-hex `x-client-request-id`.
    fn request_id(&self) -> String;
    fn now_unix_ms(&self) -> u64;
    /// The `x-codex-turn-state` token of the logical turn `turn_id` in
    /// `scope`, if an earlier response of this turn issued one.
    fn turn_state(&self, scope: &str, turn_id: &str) -> Option<String>;
    /// A process setting the wire depends on (Node's `process.env`); the process environment unless a test injects one.
    fn var(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
}

/// The client identity the Codex backend fingerprints.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CodexIdentity {
    pub installation_id: String,
    /// Both are read per request: the version is the live one (codexClientVersionSync).
    pub user_agent: crate::client_versions::Live,
    pub version: crate::client_versions::Live,
    pub beta_features: String,
}

pub const CODEX_ORIGINATOR: &str = "codex_cli_rs";
pub const CODEX_WS_BETA: &str = "responses_websockets=2026-02-06";
pub const CODEX_HTTP_BETA: &str = "responses=experimental";

/// The backend plus what only that backend needs.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Target {
    ApiKey,
    Codex(CodexIdentity),
}

#[derive(Clone)]
pub struct OpenAiConfig {
    pub target: Target,
    /// Response storage (`store`): the public API defaults to true, the
    /// Codex backend to false.
    pub store: bool,
    /// Codex route only: send `max_output_tokens` when the caller set one.
    pub send_max_output_tokens: bool,
    pub facts: Arc<dyn ModelFactsSource>,
    pub context: Arc<dyn WireContext>,
}

impl OpenAiConfig {
    pub fn api_key(
        store: bool,
        facts: Arc<dyn ModelFactsSource>,
        context: Arc<dyn WireContext>,
    ) -> Self {
        Self {
            target: Target::ApiKey,
            store,
            send_max_output_tokens: true,
            facts,
            context,
        }
    }

    pub fn codex(
        store: bool,
        send_max_output_tokens: bool,
        identity: CodexIdentity,
        facts: Arc<dyn ModelFactsSource>,
        context: Arc<dyn WireContext>,
    ) -> Self {
        Self {
            target: Target::Codex(identity),
            store,
            send_max_output_tokens,
            facts,
            context,
        }
    }

    pub fn route(&self) -> Route {
        match self.target {
            Target::ApiKey => Route::ApiKey,
            Target::Codex(_) => Route::Codex,
        }
    }
}

/// Capabilities of one model on one route, resolved once per request.
#[derive(Clone, Debug)]
pub(super) struct Capabilities {
    pub reasoning: bool,
    pub reasoning_summaries: bool,
    pub verbosity: bool,
    pub native_tool_search: bool,
}

impl Capabilities {
    pub(super) fn resolve(route: Route, facts: &ModelFacts) -> Self {
        let public = route == Route::ApiKey;
        let only_if_declared = |declared: Option<bool>| !public || declared == Some(true);
        Self {
            reasoning: !public || facts.reasoning == Some(true),
            reasoning_summaries: facts.reasoning_summaries.unwrap_or(true),
            verbosity: only_if_declared(facts.verbosity),
            native_tool_search: only_if_declared(facts.native_tool_search),
        }
    }
}

/// The connection scope of a request: its transport scope, else its session.
pub fn request_scope(request: &mixdog_core_api::domain::provider::ModelRequest) -> Option<&str> {
    request
        .options
        .transport_scope
        .as_deref()
        .or(request.options.session_id.as_deref())
}
