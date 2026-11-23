//! `WireCodec` of both Anthropic providers: pure request encoding, the SSE
//! decoder and the single failure classification. Credentials and gzip are the
//! adapter's.

// Private names for existing callback/result shapes; representations are unchanged.
type CapabilityModelLookup = dyn Fn(&str) -> Option<String> + Send + Sync;
type GatewayEffortLookup = dyn Fn(&ModelRequest) -> Option<String> + Send + Sync;

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
use super::caps::CapsLookup;
use super::decoder::AnthropicDecoder;
use super::errors::classify_response;
use super::fast_mode;
use super::fast_mode::FastMode;
use super::reminders::split_tail_reminder;
use super::threads;
use super::threads::Threads;

pub const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
/// The Claude Code release the OAuth wire identifies as.
pub const DEFAULT_CLI_VERSION: &str = "2.1.317";

use super::client_version::ClaudeClientVersion;

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
    /// A user-defined (`custom-*`) endpoint: no first-party base betas, only those its request body needs
    /// (`requestBetasFor` `base: ''`), and no server-side fallback or fast speed (`isCustom`).
    pub custom_endpoint: bool,
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
    /// A gateway's map from its routing slug to the Claude id the capabilities are read from
    /// (`config.capabilityModel`); the request still names the slug.
    pub capability_model: Option<Arc<CapabilityModelLookup>>,
    /// A gateway's own reasoning control (`config.messagesEffort`): the effort to send, `none` for no thinking at
    /// all, or `None` to keep the engine's own handling.
    pub gateway_effort: Option<Arc<GatewayEffortLookup>>,
    /// A custom endpoint's own reasoning fields: their `thinking` and `output_config` replace the engine's effort
    /// handling.
    pub custom_reasoning: Option<CustomReasoningFields>,
}

/// A custom endpoint's reasoning fields for a request, from its own model row (`resolveCustomReasoning` on the
/// `anthropic` protocol).
pub type CustomReasoningFields = Arc<dyn Fn(&ModelRequest) -> serde_json::Map<String, Value> + Send + Sync>;

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
            custom_endpoint: false,
            extra_headers: Vec::new(),
            listing: ListingLookup::new(),
            fast_mode: Arc::clone(fast_mode::process()),
            message_threads: std::env::var("MIXDOG_ANTHROPIC_MESSAGE_THREADS").map_or(true, |v| v != "0"),
            threads: Arc::clone(threads::process()),
            capability_model: None,
            gateway_effort: None,
            custom_reasoning: None,
        }
    }

    /// Whether the base URL is Anthropic's own origin, whatever the route.
    pub fn official_origin(&self) -> bool {
        self.base_url == DEFAULT_BASE_URL || self.base_url.starts_with("https://api.anthropic.com/")
    }

    /// The process switch remains a veto even when provider configuration explicitly enables threads.
    pub fn with_message_threads(mut self, enabled: Option<bool>) -> Self {
        self.message_threads &= enabled != Some(false);
        self
    }

    pub fn messages_url(&self) -> String {
        format!("{}/v1/messages", self.base_url.trim_end_matches('/'))
    }
}

/// `anthropicFirstPartyRoute(provider, config = {})` (anthropic-request-utils.mjs:116-122), the one gate of every
/// first-party-only request feature (threads, turn-scoped reminders, eager tool input streaming, effort updates): a
/// native provider, beta headers allowed and Anthropic's own base URL. `None` is Node's empty config, the one the
/// subscription route builds its body with (anthropic-oauth.mjs:236, its tools and its effort projection).
pub(super) fn first_party_route(provider: &str, config: Option<&AnthropicConfig>) -> bool {
    super::body::native_provider(provider) && config.is_none_or(|config| !config.disable_beta_headers && config.official_origin())
}

pub struct AnthropicCodec {
    flavor: Flavor,
    owner: ProviderId,
    config: AnthropicConfig,
    cli_version: Option<Arc<ClaudeClientVersion>>,
    /// The provider the capability floors this codec reads are kept under (`anthropicCapabilityEnabled`).
    floors: String,
}

impl AnthropicCodec {
    pub fn new(flavor: Flavor, config: AnthropicConfig) -> Self {
        Self { flavor, owner: ProviderId::from("anthropic"), config, cli_version: None, floors: flavor.provider_name().to_owned() }
    }

    /// The capability floors of this codec are those kept under `provider`, apart from the native routes'.
    pub(super) fn with_floors_of(mut self, provider: &str) -> Self {
        provider.clone_into(&mut self.floors);
        self
    }

    /// [`Self::with_floors_of`] in place.
    pub(super) fn set_floors_of(&mut self, provider: &str) {
        provider.clone_into(&mut self.floors);
    }

    /// The owner of the replay envelopes this wire writes and reads back.
    pub(super) fn owner(&self) -> &ProviderId {
        &self.owner
    }

    /// The provider the capability floors this codec reads are kept under.
    pub(super) fn floors(&self) -> &str {
        &self.floors
    }

    pub(super) fn with_cli_version_source(mut self, version: Option<Arc<ClaudeClientVersion>>) -> Self {
        self.cli_version = version;
        self
    }

    fn cli_user_agent(&self) -> String {
        let version = self.cli_version.as_ref().map_or_else(|| self.config.cli_version.clone(), |source| source.current());
        super::client_version::user_agent(&version)
    }

    pub(super) async fn resolve_cli_user_agent(&self) -> String {
        if let Some(source) = &self.cli_version {
            source.warm().await;
        }
        self.cli_user_agent()
    }

    pub fn flavor(&self) -> Flavor {
        self.flavor
    }

    /// The decoder of a request's stream, shared with the stream so a cut turn can be asked for its blocks.
    /// `relays_updates`: the request was sent asking for progress updates ([`super::betas::sent_display_updates`]).
    pub(super) fn decoder_with_partial(&self, request: &ModelRequest, relays_updates: bool) -> super::decoder::Shared {
        let known = body_tool_names(self, request, ToolNames::Named);
        super::decoder::Shared::new(AnthropicDecoder::for_model(self.owner.clone(), &request.model).with_known_tools(known).relaying_updates(relays_updates))
    }

    pub fn config(&self) -> &AnthropicConfig {
        &self.config
    }
}

impl WireCodec for AnthropicCodec {
    fn transport(&self) -> TransportKind {
        TransportKind::Http1
    }
    fn image_branch(&self, _: &ModelRequest) -> mixdog_image_egress::route::WireBranch {
        mixdog_image_egress::route::WireBranch::AnthropicMessages
    }

    /// The request a conversation's first send puts on the wire: its thread create form when it threads.
    fn encode(&self, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        let plain = self.encode_plain(request)?;
        Ok(self.create_form(request, plain))
    }

    fn decoder(&self, request: &ModelRequest) -> Box<dyn WireDecoder> {
        let relays_updates = self.encode(request).is_ok_and(|wire| super::betas::sent_display_updates(&beta_names(&wire)));
        Box::new(self.decoder_with_partial(request, relays_updates))
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        let mut error = classify_response(response);
        // The API-key engine posts through the Anthropic SDK, whose error names the refusal its own way.
        if self.flavor == Flavor::ApiKey {
            error.message = super::errors::sdk_message(response);
        }
        error
    }
}

/// The Messages body of Claude on Vertex AI (`_sendClaude`, vertex-ai.mjs:449-466): the request as the API-key route
/// builds it for the provider `vertex-ai` with beta headers off (no fast mode, no server-side fallback), and whether the
/// body defers a tool (the one request feature whose beta Vertex takes under its own name). `model` is the Vertex model
/// id, which the catalog is asked about.
#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
pub(crate) fn vertex_body(
    caps: &super::caps::CapsLookup,
    request: &ModelRequest,
    model: &str,
) -> Result<(serde_json::Map<String, Value>, bool), ProviderError> {
    let mut sent = request.clone();
    model.clone_into(&mut sent.model);
    sent.options.fast = false;
    let caps = caps(model);
    let cfg = BodyConfig {
        flavor: Flavor::ApiKey,
        provider_name: "vertex-ai",
        floors: "vertex-ai",
        owner: &ProviderId::from("anthropic"),
        caps: caps.as_ref(),
        cache: CacheStrategy::default(),
        max_output_tokens: None,
        first_party: first_party_route("vertex-ai", None),
        beta_headers: false,
        fast_mode: fast_mode::process(),
        gateway_effort: None,
        custom_reasoning: None,
        custom_endpoint: false,
        message_slots: std::env::var("ANTHROPIC_MSG_SLOTS").ok(),
    };
    let built = build_body(&cfg, &sent)?;
    let body = serde_json::from_slice(&built.bytes).expect("a built body is a JSON object");
    Ok((body, built.betas.tool_search))
}

/// The wire request with its body and beta names replaced by a thread plan's.
pub(super) fn threaded(wire: &WireRequest, body: &Value, betas: &[String]) -> WireRequest {
    let mut request = wire.clone();
    request.body = serde_json::to_vec(body).expect("a JSON value serialises");
    // The thread field never goes out without its beta (`'anthropic-beta': thread.betas.join(',')`, anthropic.mjs:261).
    match request.headers.iter_mut().find(|h| h.0 == "anthropic-beta") {
        Some(header) => header.1 = betas.join(","),
        None => request.headers.push(("anthropic-beta".to_owned(), betas.join(","))),
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
    /// The body's prefix fingerprint, recorded when the request is sent.
    pub prefix: super::prefix_trace::Fingerprint,
    /// The body's cache layout, for a request whose transcript a cache owner judges, once read ([`Plain::layout`]).
    pub manifest: Option<std::sync::Arc<mixdog_core_api::domain::cache_tail::WireManifest>>,
    /// The body map the layout is still to be read off (the adapter reads it on the bulk CPU lane).
    pub layout: Option<serde_json::Map<String, Value>>,
}

impl AnthropicCodec {
    /// The conversation a request threads under (its session id), or `None` when Node sends it unthreaded: a
    /// route that takes no first-party features, a one-shot fork (side question, compaction summary), a request
    /// with no session, a model the feature does not document, or a tail reminder that rides this request only.
    pub(super) fn thread_scope<'a>(&self, request: &'a ModelRequest) -> Option<&'a str> {
        let options = &request.options;
        let scope = options.session_id.as_deref().filter(|s| !s.is_empty())?;
        // Threads read the route's own config on both routes (`planAnthropicThread({ config: this.config })`).
        let first_party = first_party_route(self.floors(), Some(&self.config));
        // `carriesLegacyTailReminder`: a reminder with no text rides nothing, so it does not stop threading.
        let provider = self.floors();
        let legacy_reminder = !split_tail_reminder(&request.messages).1.is_empty() && !(first_party && turn_scoped_model(provider, &request.model));
        (self.config.message_threads
            && options.model_parameters.as_ref().and_then(|p| p.get("messageThreads")).and_then(Value::as_bool) != Some(false)
            && first_party
            && options.transport_scope.as_deref().is_none_or(str::is_empty)
            && options.shared_cache_prefix_count.is_none_or(|count| count == 0)
            && options.request_kind.as_deref() != Some("compaction")
            && threads::supports_model(&request.model)
            && crate::claude_floors::enabled(crate::claude_floors::Feature::MessageThreads, provider, &request.model)
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
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    pub(super) fn encode_plain(&self, request: &ModelRequest) -> Result<Plain, ProviderError> {
        // A gateway's capabilities are read from the Claude id its slug stands for; the wire names the slug.
        let capability = self.config.capability_model.as_ref().and_then(|map| map(&request.model));
        let caps = (self.config.caps)(capability.as_deref().unwrap_or(&request.model));
        let gateway_effort = self.config.gateway_effort.as_ref().and_then(|control| control(request));
        let custom_reasoning = self.config.custom_reasoning.as_ref().map(|resolve| resolve(request));
        let cfg = BodyConfig {
            gateway_effort: gateway_effort.as_deref(),
            custom_reasoning: custom_reasoning.as_ref(),
            custom_endpoint: self.config.custom_endpoint,
            flavor: self.flavor,
            provider_name: self.flavor.provider_name(),
            floors: self.floors(),
            owner: &self.owner,
            caps: caps.as_ref(),
            cache: self.config.cache,
            max_output_tokens: self.config.max_output_tokens,
            first_party: first_party_route(self.floors(), (self.flavor != Flavor::OAuth).then_some(&self.config)),
            beta_headers: !self.config.disable_beta_headers,
            fast_mode: &self.config.fast_mode,
            message_slots: std::env::var("ANTHROPIC_MSG_SLOTS").ok(),
        };
        let built = build_body(&cfg, request)?;
        let beta = if self.config.custom_endpoint { super::betas::custom_beta_header(built.betas) } else { beta_header(self.flavor, built.betas) };
        Ok(Plain {
            wire: WireRequest {
                transport: TransportKind::Http1,
                method: "POST".to_owned(),
                url: self.config.messages_url(),
                headers: self.request_headers(beta),
                body: built.bytes,
            },
            prefix: built.prefix,
            manifest: None,
            layout: built.layout,
        })
    }

    fn request_headers(&self, beta: String) -> Vec<(String, String)> {
        let mut headers = vec![("anthropic-version".to_owned(), ANTHROPIC_VERSION.to_owned())];
        // The API-key route with beta headers off sends none; the OAuth route
        // always does.
        if self.flavor == Flavor::OAuth || (!self.config.disable_beta_headers && !beta.is_empty()) {
            headers.push(("anthropic-beta".to_owned(), beta));
        }
        if self.flavor == Flavor::OAuth {
            headers.push(("anthropic-dangerous-direct-browser-access".to_owned(), "true".to_owned()));
            headers.push(("user-agent".to_owned(), self.cli_user_agent()));
            headers.push(("x-app".to_owned(), "cli".to_owned()));
        }
        // The subscription route spells it as `postMessages` does (`gzip-post.mjs:25`), which undici keeps on the wire.
        let content_type = if self.flavor == Flavor::OAuth { "Content-Type" } else { "content-type" };
        headers.push((content_type.to_owned(), "application/json".to_owned()));
        if self.flavor == Flavor::ApiKey {
            // The Anthropic SDK client Node sends this route through asks for JSON (fixtures/provider-wire/hosted-search/anthropic).
            headers.push(("accept".to_owned(), "application/json".to_owned()));
            layer_extra_headers(&mut headers, &self.config.extra_headers);
        }
        headers
    }
}
