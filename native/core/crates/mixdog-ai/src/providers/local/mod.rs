//! `mixdog-local`: the managed llama.cpp server, spoken to on the Chat
//! Completions wire. The endpoint (base URL and key) comes from the managed
//! runtime per turn; the only wire difference is that llama.cpp chat templates
//! accept one system message at position zero, so the instructions are merged
//! on the wire copy.
#![allow(clippy::result_large_err, reason = "ProviderError is the contract's error type")]

pub mod listing;
#[cfg(test)]
mod listing_tests;

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

use self::listing::InstalledModels;
use self::listing::LocalListing;
use crate::transport::http::HttpSend;
use crate::providers::connect::rewrite::HttpAdapter;
use crate::providers::connect::rewrite::RewriteCodec;
use crate::providers::connect::rewrite::Rewriter;
use crate::providers::connect::rewrite::StaticCredential;
use crate::providers::compat::CompatChatCodec;
use crate::providers::compat::CompatConfig;
use crate::providers::compat::CompatProfile;
use crate::providers::compat::profile::CredentialKind;

pub const PROVIDER_ID: &str = "mixdog-local";

fn refusal(message: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
    error.message = message.to_owned();
    error
}

fn instruction_text(content: &Value) -> Result<String, ProviderError> {
    match content {
        Value::String(text) => Ok(text.clone()),
        Value::Null => Ok(String::new()),
        Value::Array(parts) => {
            let mut texts = Vec::new();
            for part in parts {
                match (part.get("type").and_then(Value::as_str), part.get("text").and_then(Value::as_str)) {
                    (Some("text"), Some(text)) => texts.push(text),
                    _ => return Err(refusal("Local Provider system instructions must contain text only.")),
                }
            }
            Ok(texts.join("\n\n"))
        }
        _ => Err(refusal("Local Provider system instructions must contain text only.")),
    }
}

/// Merges every system/developer message into one leading system message.
pub fn merge_instructions(body: &mut Value) -> Result<(), ProviderError> {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    let mut instructions = Vec::new();
    let mut conversation = Vec::new();
    for message in messages.drain(..) {
        match message.get("role").and_then(Value::as_str) {
            Some("system" | "developer") => {
                instructions.push(instruction_text(message.get("content").unwrap_or(&Value::Null))?);
            }
            _ => conversation.push(message),
        }
    }
    if !instructions.is_empty() {
        messages.push(json!({"role": "system", "content": instructions.join("\n\n")}));
    }
    messages.extend(conversation);
    Ok(())
}

/// Merges the instructions of the Chat request into one system message.
pub struct LocalRewriter;

impl Rewriter for LocalRewriter {
    fn rewrite(&self, mut wire: WireRequest, _request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        let mut body: Value = serde_json::from_slice(&wire.body).map_err(|_| refusal("Local Provider body is not JSON"))?;
        merge_instructions(&mut body)?;
        wire.body = serde_json::to_vec(&body).map_err(|_| refusal("Local Provider body is not JSON"))?;
        Ok(wire)
    }
}

/// The Chat codec aimed at the endpoint the managed runtime reported.
pub fn codec(base_url: &str) -> Arc<dyn WireCodec> {
    let profile = CompatProfile::plain(PROVIDER_ID, "http://127.0.0.1/v1", CredentialKind::Keyless);
    let config = CompatConfig {
        base_url: Some(base_url.to_owned()),
        ..CompatConfig::for_profile(&profile)
    };
    Arc::new(CompatChatCodec::new(profile, config))
}

/// Where the managed llama.cpp server listens once it is up (`ensureLocalProviderServer`'s `{ baseURL, apiKey }`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Endpoint {
    pub base_url: String,
    pub api_key: String,
}

/// The managed runtime as the registered provider needs it: the installed models, and the server started (or reused)
/// for a model.
#[async_trait]
pub trait LocalRuntime: InstalledModels {
    /// `ensureLocalProviderServer(model)`.
    async fn ensure_server(&self, model: &str) -> Result<Endpoint, ProviderError>;
}

/// `MixdogLocalProvider` as the registry holds it (`registry.mjs`'s `mixdog-local` row): registered with no endpoint,
/// because the server starts on a send. Each attempt asks the runtime for the model's server and sends through the
/// Chat adapter aimed at it; the adapter is kept while the endpoint stays the same (`_providerFor`). It is text-only
/// (`nativePdf = false`) and lists the installed models.
pub struct RegisteredAdapter {
    id: ProviderId,
    codec: Arc<dyn WireCodec>,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    http: Arc<dyn HttpSend>,
    runtime: Arc<dyn LocalRuntime>,
    listing: LocalListing,
    current: Mutex<Option<(Endpoint, Arc<HttpAdapter>)>>,
}

impl RegisteredAdapter {
    pub fn new(http: Arc<dyn HttpSend>, runtime: Arc<dyn LocalRuntime>) -> Self {
        Self {
            id: ProviderId::from(PROVIDER_ID),
            codec: codec("http://127.0.0.1/v1"),
            policy: crate::providers::compat::retry::unprofiled(),
            keepalive: KeepaliveSchedule::SPEC,
            http,
            listing: LocalListing::new(runtime.clone()),
            runtime,
            current: Mutex::new(None),
        }
    }

    fn inner_for(&self, endpoint: Endpoint) -> Arc<HttpAdapter> {
        let mut current = self.current.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((kept, adapter)) = current.as_ref()
            && *kept == endpoint
        {
            return adapter.clone();
        }
        let built = Arc::new(adapter(self.http.clone(), endpoint.base_url.clone(), &endpoint.api_key, self.policy.clone(), self.runtime.clone()));
        *current = Some((endpoint, built.clone()));
        built
    }
}

#[async_trait]
impl ProviderAdapter for RegisteredAdapter {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn codec(&self) -> &dyn WireCodec {
        &*self.codec
    }

    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let endpoint = self.runtime.ensure_server(&request.model).await?;
        self.inner_for(endpoint).attempt(request).await
    }

    fn models(&self) -> Option<&dyn ModelListing> {
        Some(&self.listing)
    }

    /// `nativePdf = false`: the managed runtime is text-only.
    fn native_pdf(&self) -> bool {
        false
    }

    /// `static inputExcludesCache = false`.
    fn input_excludes_cache(&self) -> Option<bool> {
        Some(false)
    }
}

/// The adapter for the endpoint the managed runtime reported for this turn.
/// Its model listing is the runtime's installed models, not the endpoint's.
pub fn adapter(
    http: Arc<dyn HttpSend>,
    base_url: String,
    api_key: &str,
    retry_policy: RetryPolicy,
    installed: Arc<dyn InstalledModels>,
) -> HttpAdapter {
    let credential = (!api_key.is_empty()).then(|| ("authorization".to_owned(), format!("Bearer {api_key}")));
    HttpAdapter::new(
        ProviderId::from(PROVIDER_ID),
        Arc::new(RewriteCodec::new(codec(&base_url), LocalRewriter)),
        http,
        Arc::new(StaticCredential(credential)),
        retry_policy,
    )
    .with_listing(Arc::new(LocalListing::new(installed)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instructions_merge_to_one_leading_system_message() {
        let mut body = json!({"messages": [
            {"role": "system", "content": "a"},
            {"role": "user", "content": "hi"},
            {"role": "developer", "content": [{"type": "text", "text": "b"}, {"type": "text", "text": "c"}]},
        ]});
        merge_instructions(&mut body).unwrap();
        assert_eq!(
            body["messages"],
            json!([{"role": "system", "content": "a\n\nb\n\nc"}, {"role": "user", "content": "hi"}])
        );
    }

    #[test]
    fn non_text_instructions_are_refused() {
        let mut body = json!({"messages": [{"role": "system", "content": [{"type": "image_url"}]}]});
        assert!(merge_instructions(&mut body).is_err());
    }
}
