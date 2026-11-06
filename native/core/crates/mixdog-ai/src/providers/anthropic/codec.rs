//! `WireCodec` of both Anthropic providers: pure request encoding, the SSE
//! decoder and the single failure classification. Credentials and gzip are the
//! adapter's.

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_protocol::ProviderId;

use crate::catalog::ListingLookup;

use super::betas::beta_header;
use super::body::BodyConfig;
use super::body::CacheStrategy;
use super::body::build_body;
use super::caps::CapsLookup;
use super::decoder::AnthropicDecoder;
use super::errors::classify_response;

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
        }
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

    fn encode(&self, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
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
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        if self.flavor == Flavor::ApiKey {
            layer_extra_headers(&mut headers, &self.config.extra_headers);
        }
        Ok(WireRequest {
            transport: TransportKind::Http1,
            method: "POST".to_owned(),
            url: self.config.messages_url(),
            headers,
            body: built.bytes,
        })
    }

    fn decoder(&self, _request: &ModelRequest) -> Box<dyn WireDecoder> {
        Box::new(AnthropicDecoder::new(self.owner.clone()))
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        classify_response(response)
    }
}
