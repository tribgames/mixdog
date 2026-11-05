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
pub mod codec;
pub mod decode;
pub mod error;
pub mod json;
pub mod models;
pub mod policy;
pub mod request;
pub mod schema;
pub mod serving;
pub mod traits;

#[cfg(test)]
mod conformance;

use adapter::GoogleAdapter;
use auth::ApiKeyAuth;
use auth::RequestAuth;
use auth::antigravity::AntigravityAuth;
use auth::antigravity::TokenStore;
use codec::GoogleCodec;
use crate::transport::HttpSend;
use traits::ModelTraits;

/// `gemini`: the Gemini API with an API key.
pub fn gemini(
    api_key: impl Into<String>,
    http: Arc<dyn HttpSend>,
    traits: Arc<dyn ModelTraits>,
) -> GoogleAdapter {
    let api_key = api_key.into();
    let cache = cache::layer::ExplicitCache::new(
        api_key.clone(),
        codec::GEMINI_ORIGIN,
        http.clone(),
        Arc::new(cache::runtime::RtCacheRuntime),
        cache::registry::Registry::shared(),
        cache::policy::Tuning::from_env(|name| std::env::var(name).ok()),
    );
    GoogleAdapter::new(
        GoogleCodec::gemini(codec::GEMINI_ORIGIN, traits),
        policy::gemini(),
        http,
        Arc::new(ApiKeyAuth::new(api_key)),
        String::new(),
    )
    .with_cache(cache)
}

/// `vertex-ai` on a project, with minted tokens or a key. `place` decides each
/// request's location ([`serving::VertexPlace::choose`]); `identity` is the
/// credential's ([`auth::vertex::VertexAuth::identity`]).
pub fn vertex(
    place: serving::VertexPlace,
    auth: Arc<dyn RequestAuth>,
    identity: String,
    http: Arc<dyn HttpSend>,
    traits: Arc<dyn ModelTraits>,
) -> GoogleAdapter {
    GoogleAdapter::new(GoogleCodec::vertex(place, traits), policy::gemini(), http, auth, identity)
}

/// `vertex-ai` in express mode: an API key on the global endpoint.
pub fn vertex_express(
    api_key: impl Into<String>,
    http: Arc<dyn HttpSend>,
    traits: Arc<dyn ModelTraits>,
) -> GoogleAdapter {
    vertex(
        serving::VertexPlace::express(),
        Arc::new(ApiKeyAuth::new(api_key)),
        String::new(),
        http,
        traits,
    )
}

/// `antigravity-oauth`, bound to the signed-in account's Cloud project. A
/// new sign-in with another project needs a new adapter; the old one then
/// refuses to send.
pub async fn antigravity(
    store: Arc<dyn TokenStore>,
    client_version: String,
    http: Arc<dyn HttpSend>,
    traits: Arc<dyn ModelTraits>,
    now_ms: Box<dyn Fn() -> u64 + Send + Sync>,
) -> Result<GoogleAdapter, ProviderError> {
    let auth = Arc::new(AntigravityAuth::new(http.clone(), store, now_ms));
    let tokens = auth.current().await?;
    Ok(GoogleAdapter::new(
        GoogleCodec::antigravity(
            auth::antigravity::ENDPOINT,
            tokens.project_id.clone(),
            client_version,
            traits,
        ),
        policy::antigravity(),
        http,
        auth,
        tokens.project_id,
    ))
}
