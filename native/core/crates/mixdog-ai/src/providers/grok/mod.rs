//! `grok-oauth`: the xAI Responses wire through the Grok CLI proxy
//! (`cli-chat-proxy.grok.com`), signed in with the account's OAuth tokens.
//!
//! The wire is the xAI Responses codec of the compat family (its request
//! body, stream decoding and error classification); this module owns what is
//! Grok's: the proxy endpoint, the CLI identity headers that clear the
//! proxy's version gate, and the credential.
#![allow(clippy::result_large_err, reason = "ProviderError is the contract's error type")]

pub mod auth;

use std::sync::Arc;

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;

use self::auth::GrokCredential;
use crate::transport::http::HttpSend;
use crate::providers::connect::rewrite::HttpAdapter;
use crate::providers::connect::rewrite::RewriteCodec;
use crate::providers::connect::rewrite::Rewriter;
use crate::providers::compat::CompatConfig;
use crate::providers::connect::random_uuid;
use crate::providers::compat::CompatProfile;
use crate::providers::compat::responses::CompatResponsesCodec;

pub const PROVIDER_ID: &str = "grok-oauth";
pub const PROXY_BASE_URL: &str = "https://cli-chat-proxy.grok.com/v1";
const CLIENT_IDENTIFIER: &str = "grok-shell";
/// The oldest CLI release the proxy accepts; a newer one is configured.
pub const CLIENT_VERSION_FLOOR: &str = "1.0.70";

/// Points the xAI request at the proxy and adds the CLI identity headers.
pub struct GrokRewriter {
    pub client_version: String,
    pub credential: Arc<GrokCredential>,
}

impl Rewriter for GrokRewriter {
    fn rewrite(&self, mut wire: WireRequest, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        let opts = &request.options;
        let mut add = |name: &str, value: String| wire.headers.push((name.to_owned(), value));
        add("x-grok-client-version", self.client_version.clone());
        add("x-grok-client-identifier", CLIENT_IDENTIFIER.to_owned());
        add("user-agent", format!("xai-grok-build/{}", self.client_version));
        // The session id is Mixdog's own; no Grok conversation id is made up.
        if let Some(session) = opts.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            add("x-grok-session-id", session.to_owned());
        }
        add("x-grok-req-id", random_uuid());
        if !request.model.is_empty() {
            add("x-grok-model-override", request.model.clone());
        }
        add("x-grok-turn-idx", opts.iteration.to_string());
        if let Some(user) = self.credential.user_id() {
            add("x-grok-user-id", user);
        }
        Ok(wire)
    }
}

/// The xAI Responses codec aimed at the Grok CLI proxy.
pub fn codec(client_version: &str) -> Arc<dyn WireCodec> {
    let profile = CompatProfile::xai();
    let config = CompatConfig {
        base_url: Some(PROXY_BASE_URL.to_owned()),
        client_version: client_version.to_owned(),
        ..CompatConfig::for_profile(&profile)
    };
    Arc::new(CompatResponsesCodec::new(profile, config, TransportKind::Http1))
}

/// The Grok adapter around the xAI Responses codec.
pub fn adapter(
    http: Arc<dyn HttpSend>,
    credential: Arc<GrokCredential>,
    client_version: Option<String>,
    retry_policy: RetryPolicy,
) -> HttpAdapter {
    let client_version = client_version.unwrap_or_else(|| CLIENT_VERSION_FLOOR.to_owned());
    let rewriter = GrokRewriter {
        client_version: client_version.clone(),
        credential: credential.clone(),
    };
    HttpAdapter::new(
        ProviderId::from(PROVIDER_ID),
        Arc::new(RewriteCodec::new(codec(&client_version), rewriter)),
        http,
        credential,
        retry_policy,
    )
}
