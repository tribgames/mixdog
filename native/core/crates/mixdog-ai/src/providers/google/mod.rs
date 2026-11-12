//! `gemini`, `vertex-ai` (Gemini publisher) and `antigravity-oauth`: three
//! endpoints that speak the Gemini `streamGenerateContent` dialect (PW
//! §5.8–5.10). One [`codec::GoogleCodec`] and one [`adapter::GoogleAdapter`]
//! serve all three; they differ in target, credentials, a few request fields
//! ([`request::Dialect`]), error reading and the retry rows ([`policy`]).
//!
//! No timer exists here: a stream dies by transport facts, a missing
//! `finishReason`, a typed provider error or the consumer dropping it.

use std::sync::Arc;

use mixdog_core_api::domain::provider::ProviderError;

pub mod adapter;
pub mod auth;
pub mod cache;
pub mod claude;
pub mod codec;
pub mod decode;
pub mod error;
pub mod json;
pub mod models;
pub mod policy;
pub mod maas;
pub mod redirect;
pub mod request;
pub mod schema;
pub mod serving;
pub mod tool_accept;
pub mod traits;

#[cfg(test)]
mod claude_replay_wire_tests;
#[cfg(test)]
mod first_response_budget_tests;
#[cfg(test)]
mod conformance;
#[cfg(test)]
pub(crate) mod wire_tests;
#[cfg(test)]
mod tool_accept_tests;
#[cfg(test)]
mod maas_wire_tests;
#[cfg(test)]
mod usage_wire_tests;
#[cfg(test)]
mod vertex_claude_cancel_wire_tests;
#[cfg(test)]
mod vertex_claude_wire_tests;

use adapter::GoogleAdapter;
use auth::ApiKeyAuth;
use auth::RequestAuth;
use auth::antigravity::AntigravityAuth;
use auth::antigravity::TokenStore;
use codec::GoogleCodec;
use crate::providers::anthropic::CapsLookup;
use crate::providers::key_source::ApiKeySource;
use crate::transport::HttpSend;
use traits::ModelTraits;

/// `gemini`: the Gemini API with an API key.
pub fn gemini(
    api_key: impl Into<String>,
    http: Arc<dyn HttpSend>,
    traits: Arc<dyn ModelTraits>,
) -> GoogleAdapter {
    gemini_keyed(Arc::new(auth::HeldKey(api_key.into())), http, traits)
}

/// [`gemini`] with a key read at each request and re-read after a 401 (`resolveProviderApiKey`,
/// `reloadProviderApiKey`).
pub fn gemini_keyed(
    key: Arc<dyn ApiKeySource>,
    http: Arc<dyn HttpSend>,
    traits: Arc<dyn ModelTraits>,
) -> GoogleAdapter {
    gemini_with(
        key,
        http,
        traits,
        Arc::new(cache::runtime::RtCacheRuntime),
        cache::registry::Registry::shared(),
        cache::policy::Tuning::from_env(|name| std::env::var(name).ok()),
    )
}

/// [`gemini`] over the given clock/task seam, cache registry and tuning: the one wiring, so a test drives the
/// production adapter with a virtual clock.
pub fn gemini_with(
    key: Arc<dyn ApiKeySource>,
    http: Arc<dyn HttpSend>,
    traits: Arc<dyn ModelTraits>,
    runtime: Arc<dyn cache::layer::CacheRuntime>,
    registry: Arc<cache::registry::Registry>,
    tuning: cache::policy::Tuning,
) -> GoogleAdapter {
    // The cache serves the key of each request (`ExplicitCache::keyed`); this one is only its template.
    let cache = cache::layer::ExplicitCache::new(
        "",
        codec::GEMINI_ORIGIN,
        http.clone(),
        runtime,
        registry,
        tuning,
    );
    GoogleAdapter::new(
        GoogleCodec::gemini(codec::GEMINI_ORIGIN, traits),
        policy::gemini(),
        http,
        Arc::new(ApiKeyAuth::from_source(key.clone())),
        String::new(),
    )
    .with_key_reload(key)
    .with_cache(cache)
}

/// `vertex-ai` on a project, with minted tokens or a key. `place` decides each
/// request's location ([`serving::VertexPlace::choose`]); `identity` is the
/// credential's ([`auth::vertex::VertexAuth::identity`]); `claude_caps` the
/// Anthropic catalog a Claude request is built from.
pub fn vertex(
    place: serving::VertexPlace,
    auth: Arc<dyn RequestAuth>,
    identity: String,
    http: Arc<dyn HttpSend>,
    traits: Arc<dyn ModelTraits>,
    claude_caps: CapsLookup,
) -> GoogleAdapter {
    GoogleAdapter::new(GoogleCodec::vertex(place, traits).with_claude_caps(claude_caps), policy::gemini(), http, auth, identity)
}

/// `vertex-ai` in express mode: an API key on the global endpoint.
pub fn vertex_express(
    api_key: impl Into<String>,
    http: Arc<dyn HttpSend>,
    traits: Arc<dyn ModelTraits>,
) -> GoogleAdapter {
    // An express key serves Gemini models only: no Claude request is built.
    vertex(
        serving::VertexPlace::express(),
        Arc::new(ApiKeyAuth::new(api_key)),
        String::new(),
        http,
        traits,
        Arc::new(|_| None),
    )
}

/// `antigravity-oauth`, bound to the signed-in account's Cloud project. A
/// new sign-in with another project needs a new adapter; the old one then
/// refuses to send.
pub async fn antigravity(
    store: Arc<dyn TokenStore>,
    client_version: crate::client_versions::Live,
    http: Arc<dyn HttpSend>,
    traits: Arc<dyn ModelTraits>,
    now_ms: Box<dyn Fn() -> u64 + Send + Sync>,
    function_calling_mode: Option<&str>,
) -> Result<GoogleAdapter, ProviderError> {
    let auth = Arc::new(AntigravityAuth::new(http.clone(), store, now_ms));
    let tokens = auth.current().await?;
    Ok(GoogleAdapter::new(
        GoogleCodec::antigravity(
            auth::antigravity::ENDPOINT,
            tokens.project_id.clone(),
            client_version,
            traits,
        )
        .with_function_calling_mode(function_calling_mode),
        policy::antigravity(),
        http,
        auth,
        tokens.project_id,
    ))
}
