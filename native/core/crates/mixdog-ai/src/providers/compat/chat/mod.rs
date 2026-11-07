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
use super::schema::{Rule, SchemaMemo, report_exclusion};
use crate::providers::google::tool_accept::gemini_accepted_tools;
use crate::providers::leak::{ToolNames, body_tool_names};
use crate::providers::google::traits::is_gemini_family_model;

/// What differs between two instances of one profile.
#[derive(Clone, Debug)]
pub struct CompatConfig {
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

    /// The rows the last listing returned (and the profile's seed facts).
    pub fn models(&self) -> &ModelTable {
        &self.config.models
    }

    /// The headers the configuration adds to every request (a login's
    /// organization, a gateway's own).
    pub fn extra_headers(&self) -> &[(String, String)] {
        &self.config.extra_headers
    }

    pub fn base_url(&self) -> &str {
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
        // A Gemini-family model behind this route (google/gemini-* on OpenRouter) fails the whole
        // request on one schema Google rejects; such a tool is left out and reported like on the
        // native Gemini routes. Every other model's `parameters` must be a valid 2020-12 object
        // schema; a draft-07 one is lowered, a broken one left out and reported.
        let tools = if is_gemini_family_model(&request.model) {
            gemini_accepted_tools(&request.tools, &mut |e| report_exclusion(&request.options, e))
        } else {
            let source = format!("[{}] tool", self.profile.id);
            self.schemas.accepted_wire_tools(&request.tools, Rule::OpenAi, &source, &mut |e| {
                report_exclusion(&request.options, e)
            })
        };
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

    fn decoder(&self, request: &ModelRequest) -> Box<dyn WireDecoder> {
        let known = body_tool_names(self, request, ToolNames::Chat);
        Box::new(ChatDecoder::new(self.profile.clone(), self.provider.clone()).with_known_tools(known))
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        error::classify(&self.profile, response)
    }
}
