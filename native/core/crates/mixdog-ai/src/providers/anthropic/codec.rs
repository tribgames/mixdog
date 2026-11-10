//! `WireCodec` of both Anthropic providers: pure request encoding, the SSE
//! decoder and the single failure classification. Credentials and gzip are the
//! adapter's.

use std::sync::Arc;

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_protocol::ProviderId;
use serde_json::Value;

use crate::catalog::ListingLookup;
use crate::providers::leak::ToolNames;
use crate::providers::leak::body_tool_names;

use super::betas::beta_header;
use super::body::BodyConfig;
use super::body::CacheStrategy;
use super::body::build_body;
use super::body::turn_scoped_model;
use super::threads;
use super::threads::Threads;
use super::caps::CapsLookup;
use super::decoder::AnthropicDecoder;
use super::fast_mode;
use super::fast_mode::FastMode;
use super::errors::classify_response;
use super::reminders::split_tail_reminder;

pub const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
/// The Claude Code release the OAuth wire identifies as.
pub const DEFAULT_CLI_VERSION: &str = "2.1.317";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavor {
    /// `anthropic`: API key, `x-api-key`.
    ApiKey,
    /// `anthropic-oauth`: Claude subscription, bearer token.
    OAuth,
}

impl Flavor {
    pub fn provider_name(self) -> &'static str {
        match self {
            Self::ApiKey => "anthropic",
            Self::OAuth => "anthropic-oauth",
        }
    }
}

#[derive(Clone)]
pub struct AnthropicConfig {
    pub base_url: String,
    pub caps: CapsLookup,
    pub cache: CacheStrategy,
    /// A user-chosen `max_tokens` ceiling.
    pub max_output_tokens: Option<u32>,
    /// Version the OAuth `user-agent` names.
    pub cli_version: String,
    /// The API-key route's `disableBetaHeaders`: no first-party-only request
    /// features, no server-side fallback, no mid-conversation effort updates.
    pub disable_beta_headers: bool,
    /// The provider's configured `extraHeaders`, sent on the API-key route's
    /// messages and listing requests. They replace a default header of the
    /// same name (`anthropic-version`, `x-api-key`), except `anthropic-beta`
    /// when the request names its own betas. The subscription route sends none.
    pub extra_headers: Vec<(String, String)>,
    /// The catalog tables the listing's enrichment and sanitizer read: the
    /// handle the composition hands to `CatalogService::with_listing_lookup`.
    pub listing: ListingLookup,
    /// The fast-mode cooldown and disabled reason: the process-wide one.
    pub fast_mode: Arc<FastMode>,
    /// Message threads (`messageThreads` of the provider config and `MIXDOG_ANTHROPIC_MESSAGE_THREADS`): on
    /// unless turned off. A conversation's thread state lives in `threads`.
    pub message_threads: bool,
    /// The thread state of every conversation: the process-wide one.
    pub threads: Arc<Threads>,
}

/// Layers `extra` over `headers`: a same-named header (any case) is replaced,
/// and a request's own `anthropic-beta` is kept over an extra one.
pub(super) fn layer_extra_headers(headers: &mut Vec<(String, String)>, extra: &[(String, String)]) {
    for (name, value) in extra {
        let same = |h: &(String, String)| h.0.eq_ignore_ascii_case(name);
        if name.eq_ignore_ascii_case("anthropic-beta") && headers.iter().any(same) {
            continue;
        }
        headers.retain(|h| !same(h));
        headers.push((name.clone(), value.clone()));
    }
}

impl AnthropicConfig {
    pub fn new(caps: CapsLookup) -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_owned(),
            caps,
            cache: CacheStrategy::default(),
            max_output_tokens: None,
            cli_version: DEFAULT_CLI_VERSION.to_owned(),
            disable_beta_headers: false,
            extra_headers: Vec::new(),
            listing: ListingLookup::new(),
            fast_mode: Arc::clone(fast_mode::process()),
            message_threads: std::env::var("MIXDOG_ANTHROPIC_MESSAGE_THREADS").map_or(true, |v| v != "0"),
            threads: Arc::clone(threads::process()),
        }
    }

    /// Anthropic's own first-party Messages route (`anthropicFirstPartyRoute`): beta headers allowed and no
    /// gateway base URL. Request features a proxy answers with a 400 are gated here.
    pub(super) fn first_party_route(&self) -> bool {
        !self.disable_beta_headers && self.official_origin()
    }

    /// Whether the endpoint is Anthropic's own: first-party-only request
    /// features are sent only there.
    fn first_party(&self, flavor: Flavor) -> bool {
        flavor == Flavor::OAuth || (!self.disable_beta_headers && self.official_origin())
    }

    /// Whether the base URL is Anthropic's own origin, whatever the route.
    pub fn official_origin(&self) -> bool {
        self.base_url == DEFAULT_BASE_URL || self.base_url.starts_with("https://api.anthropic.com/")
    }

    pub fn messages_url(&self) -> String {
        format!("{}/v1/messages", self.base_url.trim_end_matches('/'))
    }

    /// Whether this is Anthropic's own messages endpoint (the only one that
    /// takes a gzip request body).
    pub fn is_official_messages_url(&self) -> bool {
        self.messages_url() == format!("{DEFAULT_BASE_URL}/v1/messages")
    }
}

pub struct AnthropicCodec {
    flavor: Flavor,
    owner: ProviderId,
    config: AnthropicConfig,
}

impl AnthropicCodec {
    pub fn new(flavor: Flavor, config: AnthropicConfig) -> Self {
        Self {
            flavor,
            owner: ProviderId::from("anthropic"),
            config,
        }
    }

    pub fn flavor(&self) -> Flavor {
        self.flavor
    }

    pub fn config(&self) -> &AnthropicConfig {
        &self.config
    }
}

impl WireCodec for AnthropicCodec {
    fn transport(&self) -> TransportKind {
        TransportKind::Http1
    }

    /// The request a conversation's first send puts on the wire: its thread create form when it threads.
    fn encode(&self, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        let plain = self.encode_plain(request)?;
        Ok(self.create_form(request, plain))
    }

    fn decoder(&self, request: &ModelRequest) -> Box<dyn WireDecoder> {
        let known = body_tool_names(self, request, ToolNames::Named);
        Box::new(AnthropicDecoder::new(self.owner.clone()).with_known_tools(known))
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        classify_response(response)
    }
}

/// The wire request with its body and beta names replaced by a thread plan's.
pub(super) fn threaded(wire: &WireRequest, body: &Value, betas: &[String]) -> WireRequest {
    let mut request = wire.clone();
    request.body = serde_json::to_vec(body).expect("a JSON value serialises");
    if let Some(header) = request.headers.iter_mut().find(|h| h.0 == "anthropic-beta") {
        header.1 = betas.join(",");
    }
    request
}

/// The `anthropic-beta` names a wire request sends.
pub(super) fn beta_names(wire: &WireRequest) -> Vec<String> {
    wire.headers
        .iter()
        .find(|h| h.0 == "anthropic-beta")
        .map(|h| h.1.split(',').map(str::trim).filter(|b| !b.is_empty()).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// A request built for one attempt, before any thread plan.
pub(super) struct Plain {
    pub wire: WireRequest,
}

impl AnthropicCodec {
    /// The conversation a request threads under (its session id), or `None` when Node sends it unthreaded: a
    /// route that takes no first-party features, a one-shot fork (side question, compaction summary), a request
    /// with no session, a model the feature does not document, or a tail reminder that rides this request only.
    pub(super) fn thread_scope<'a>(&self, request: &'a ModelRequest) -> Option<&'a str> {
        let options = &request.options;
        let scope = options.session_id.as_deref().filter(|s| !s.is_empty())?;
        let first_party = self.config.first_party_route();
        // `carriesLegacyTailReminder`: a reminder with no text rides nothing, so it does not stop threading.
        let legacy_reminder = !split_tail_reminder(&request.messages).1.is_empty() && !(first_party && turn_scoped_model(&request.model));
        (self.config.message_threads
            && first_party
            && options.transport_scope.as_deref().is_none_or(str::is_empty)
            && options.shared_cache_prefix_count.is_none_or(|count| count == 0)
            && options.request_kind.as_deref() != Some("compaction")
            && threads::supports_model(&request.model)
            && !legacy_reminder)
            .then_some(scope)
    }

    /// The resolved per-layer cache TTLs a thread's fingerprint holds.
    pub(super) fn cache_ttls(&self, request: &ModelRequest) -> String {
        let overrides = request.options.model_parameters.as_ref().and_then(|p| p.get("cacheStrategy"));
        format!("{:?}|{}", self.config.cache, overrides.map_or(String::new(), Value::to_string))
    }

    fn create_form(&self, request: &ModelRequest, plain: Plain) -> WireRequest {
        if self.thread_scope(request).is_none() {
            return plain.wire;
        }
        let Ok(body) = serde_json::from_slice::<Value>(&plain.wire.body) else { return plain.wire };
        match threads::create_form(&body, &beta_names(&plain.wire)) {
            Some((wire, betas)) => threaded(&plain.wire, &wire, &betas),
            None => plain.wire,
        }
    }

    /// The full request, unthreaded: what Node's request builder makes and a cache warm sends.
    pub(super) fn encode_plain(&self, request: &ModelRequest) -> Result<Plain, ProviderError> {
        let caps = (self.config.caps)(&request.model);
        let cfg = BodyConfig {
            flavor: self.flavor,
            provider_name: self.flavor.provider_name(),
            owner: &self.owner,
            caps: caps.as_ref(),
            cache: self.config.cache,
            max_output_tokens: self.config.max_output_tokens,
            first_party: self.config.first_party(self.flavor),
            official_url: self.config.official_origin(),
            beta_headers: !self.config.disable_beta_headers,
            fast_mode: &self.config.fast_mode,
        };
        let built = build_body(&cfg, request)?;
        let beta = beta_header(self.flavor, built.betas);
        let mut headers = vec![("anthropic-version".to_owned(), ANTHROPIC_VERSION.to_owned())];
        // The API-key route with beta headers off sends none; the OAuth route
        // always does.
        if self.flavor == Flavor::OAuth || (!self.config.disable_beta_headers && !beta.is_empty()) {
            headers.push(("anthropic-beta".to_owned(), beta));
        }
        if self.flavor == Flavor::OAuth {
            headers.push(("anthropic-dangerous-direct-browser-access".to_owned(), "true".to_owned()));
            headers.push((
                "user-agent".to_owned(),
                format!("claude-cli/{} (external, sdk-cli)", self.config.cli_version),
            ));
            headers.push(("x-app".to_owned(), "cli".to_owned()));
        }
        // The subscription route spells it as `postMessages` does (`gzip-post.mjs:25`), which undici keeps on the wire.
        let content_type = if self.flavor == Flavor::OAuth { "Content-Type" } else { "content-type" };
        headers.push((content_type.to_owned(), "application/json".to_owned()));
        if self.flavor == Flavor::ApiKey {
            layer_extra_headers(&mut headers, &self.config.extra_headers);
        }
        Ok(Plain {
            wire: WireRequest {
                transport: TransportKind::Http1,
                method: "POST".to_owned(),
                url: self.config.messages_url(),
                headers,
                body: built.bytes,
            },
        })
    }
}
