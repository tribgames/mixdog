//! The Chat Completions wire of the OpenAI-compatible family as a pure
//! [`WireCodec`]: request body, per-request headers, stream decoding and
//! failure classification. Credentials and I/O belong to the adapter.

mod decode;
mod encode;
mod options;
mod reasoning;

use std::sync::Arc;

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::{
    ErrorResponse, ModelRequest, ProviderError, WireCodec, WireDecoder, WireRequest,
};
use mixdog_protocol::ProviderId;

pub use decode::{ChatDecoder, usage_from};
pub(crate) use encode::system_texts;
pub use super::profile::CostField;

use super::error;
use super::models::ModelTable;
use super::profile::CompatProfile;
use super::schema::{Rule, SchemaMemo, ToolExclusion};

/// Receives each tool a request had to leave out (the agent loop records it
/// for the session).
#[derive(Clone)]
pub struct ExclusionSink(pub Arc<dyn Fn(ToolExclusion) + Send + Sync>);

impl std::fmt::Debug for ExclusionSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ExclusionSink")
    }
}

/// What differs between two instances of one profile.
#[derive(Clone, Debug)]
pub struct CompatConfig {
    /// Without a sink an excluded tool is logged.
    pub on_tool_excluded: Option<ExclusionSink>,
    /// The server hosts tool search (xAI opt-in): one `tool_search` tool
    /// replaces the client loader on the Responses wire.
    pub server_tool_search: bool,
    /// Overrides the profile's endpoint (a configured or stored base URL).
    pub base_url: Option<String>,
    /// The client version in the `User-Agent` of dialects that send one.
    pub client_version: String,
    /// Headers added to the profile's own, after them.
    pub extra_headers: Vec<(String, String)>,
    pub models: Arc<ModelTable>,
    /// The process environment the cache-routing knobs
    /// (`MIXDOG_XAI_RESPONSES_CACHE_*`) are read from; none reads nothing.
    pub environment: Option<EnvSource>,
}

/// The injectable process environment (`registry::keys::Environment`).
#[derive(Clone)]
pub struct EnvSource(pub Arc<dyn crate::registry::keys::Environment>);

impl std::fmt::Debug for EnvSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EnvSource")
    }
}

impl Default for CompatConfig {
    fn default() -> Self {
        Self {
            environment: None,
            on_tool_excluded: None,
            server_tool_search: false,
            base_url: None,
            client_version: String::new(),
            extra_headers: Vec::new(),
            models: Arc::new(ModelTable::default()),
        }
    }
}

impl CompatConfig {
    /// A config whose model table carries the profile's seed facts.
    pub fn for_profile(profile: &CompatProfile) -> Self {
        Self {
            models: profile.model_table(),
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug)]
pub struct CompatChatCodec {
    profile: CompatProfile,
    provider: ProviderId,
    config: CompatConfig,
    schemas: Arc<SchemaMemo>,
}

impl CompatChatCodec {
    pub fn new(profile: CompatProfile, config: CompatConfig) -> Self {
        Self {
            schemas: Arc::new(SchemaMemo::default()),
            provider: ProviderId::from(profile.id),
            profile,
            config,
        }
    }

    pub fn profile(&self) -> &CompatProfile {
        &self.profile
    }

    fn base_url(&self) -> &str {
        self.config
            .base_url
            .as_deref()
            .unwrap_or(self.profile.base_url)
            .trim_end_matches('/')
    }

    fn headers(&self, request: &ModelRequest) -> Vec<(String, String)> {
        let mut headers: Vec<(String, String)> = vec![
            ("content-type".into(), "application/json".into()),
            ("accept".into(), "application/json".into()),
        ];
        headers.extend(
            self.profile
                .headers
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
        );
        let dialect = &self.profile.chat;
        if dialect.session_affinity_headers {
            headers.push((
                "user-agent".into(),
                format!("mimocode/{}", self.config.client_version),
            ));
            if let Some(session) = request.options.session_id.as_deref().filter(|s| !s.is_empty()) {
                headers.push(("x-session-affinity".into(), session.to_owned()));
                if let Some(parent) = request.options.parent_session_id.as_deref().filter(|s| !s.is_empty()) {
                    headers.push(("x-parent-session-id".into(), parent.to_owned()));
                }
            }
        }
        if dialect.conversation_header
            && let Some(key) = request.options.prompt_cache_key.as_deref().filter(|k| !k.is_empty())
        {
            // Pins the conversation to the server holding its cached prefix.
            headers.push(("x-grok-conv-id".into(), key.to_owned()));
        }
        headers.extend(self.config.extra_headers.iter().cloned());
        headers
    }
}

impl WireCodec for CompatChatCodec {
    fn transport(&self) -> TransportKind {
        TransportKind::Http1
    }

    fn encode(&self, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        let info = self.config.models.get(&request.model);
        // Every `parameters` must be a valid 2020-12 object schema; a draft-07
        // one is lowered, a broken one left out and reported.
        let source = format!("[{}] tool", self.profile.id);
        let tools = self.schemas.accepted_wire_tools(&request.tools, Rule::OpenAi, &source, &mut |e| {
            match &self.config.on_tool_excluded {
                Some(sink) => (sink.0)(e),
                None => tracing::warn!("{}", e.message),
            }
        });
        let body = encode::build_body(&self.profile, &self.provider, request, info.as_deref(), &tools)?;
        Ok(WireRequest {
            transport: TransportKind::Http1,
            method: "POST".into(),
            url: format!("{}/chat/completions", self.base_url()),
            headers: self.headers(request),
            // A JSON object always serializes.
            body: serde_json::to_vec(&body).unwrap_or_default(),
        })
    }

    fn decoder(&self, _request: &ModelRequest) -> Box<dyn WireDecoder> {
        Box::new(ChatDecoder::new(self.profile.clone(), self.provider.clone()))
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        error::classify(&self.profile, response)
    }
}
