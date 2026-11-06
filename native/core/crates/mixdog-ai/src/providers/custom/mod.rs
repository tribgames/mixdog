//! User-defined (`custom-<uuid>`) providers: a secret-free config entry names
//! an endpoint, a protocol, optional headers and extra request fields. The
//! runtime reuses the family codec of the protocol; this module owns the
//! config rules and the endpoint/header/body layering.
#![allow(clippy::result_large_err, reason = "ProviderError is the contract's error type")]

use std::sync::Arc;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;

use crate::transport::http::HttpSend;
use crate::providers::connect::rewrite::HttpAdapter;
use crate::providers::connect::rewrite::RewriteCodec;
use crate::providers::connect::rewrite::Rewriter;
use crate::providers::connect::rewrite::StaticCredential;
use crate::providers::compat::CompatChatCodec;
use crate::providers::compat::CompatConfig;
use crate::providers::compat::CompatProfile;
use crate::providers::compat::profile::CredentialKind;
use crate::providers::compat::profile::Wire;
use crate::providers::compat::responses::CompatResponsesCodec;
use mixdog_core_api::domain::keepalive::TransportKind;
use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::PoisonError;

pub mod listing;
pub mod reasoning;

pub const HEADER_LIMIT: usize = 64;
pub const REQUEST_BODY_MAX_CHARS: usize = 16384;
const MAX_HEADER_TEXT: usize = 4096;
/// Body fields the app builds itself.
pub const RESERVED_BODY_KEYS: &[&str] = &[
    "model", "messages", "input", "system", "instructions", "tools", "tool_choice", "parallel_tool_calls", "stream",
    "stream_options", "previous_response_id", "store", "include", "prompt_cache_key", "max_tokens",
    "max_output_tokens", "max_completion_tokens",
];
const UNSAFE_KEYS: &[&str] = &["__proto__", "constructor", "prototype"];
/// Credentials belong to the API key field.
const AUTH_HEADERS: &[&str] = &["authorization", "x-api-key", "api-key"];
/// Transport headers the HTTP client owns.
const MODEL_REFUSED_HEADERS: &[&str] =
    &["content-type", "content-length", "host", "connection", "transfer-encoding", "proxy-authorization"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    OpenaiChat,
    OpenaiResponses,
    Anthropic,
}

/// The normalized request-shaping part of a custom provider config.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CustomRequestConfig {
    pub base_url: String,
    pub headers: Vec<(String, String)>,
    pub request_body: Map<String, Value>,
    /// Per model: extra body fields and headers over the provider's.
    pub model_body: Map<String, Value>,
    pub model_headers: Vec<(String, Vec<(String, String)>)>,
}

fn invalid(message: String) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
    error.message = format!("[custom-provider] {message}");
    error
}

/// Validates a header map: tokens for names, visible ASCII for values, no
/// credentials, no duplicates (case-insensitive), at most [`HEADER_LIMIT`].
pub fn normalize_headers(
    raw: &Map<String, Value>,
    label: &str,
    refused: &[&str],
) -> Result<Vec<(String, String)>, ProviderError> {
    if raw.len() > HEADER_LIMIT {
        return Err(invalid(format!("at most {HEADER_LIMIT} {label} are allowed")));
    }
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for (name, value) in raw {
        let token = |c: char| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c);
        if name.is_empty() || name.len() > MAX_HEADER_TEXT || !name.chars().all(token) {
            return Err(invalid(format!("{label} has an invalid header name")));
        }
        let lower = name.to_ascii_lowercase();
        if AUTH_HEADERS.contains(&lower.as_str()) {
            return Err(invalid(format!("{label} must not set {name}: authentication belongs to the API key field")));
        }
        if refused.contains(&lower.as_str()) {
            return Err(invalid(format!("{label} must not set {name}: the app owns this header")));
        }
        if seen.contains(&lower) {
            return Err(invalid(format!("{label} has duplicate header: {name}")));
        }
        seen.push(lower);
        let Some(text) = value.as_str() else {
            return Err(invalid(format!("{label}.{name} must be a string")));
        };
        if !text.chars().all(|c| c == '\t' || (' '..='~').contains(&c) || ('\u{80}'..='\u{ff}').contains(&c)) {
            return Err(invalid(format!("{label}.{name} has an invalid value")));
        }
        let trimmed = text.trim_matches([' ', '\t']);
        if trimmed.len() > MAX_HEADER_TEXT {
            return Err(invalid(format!("{label}.{name} has an invalid value")));
        }
        out.push((name.clone(), trimmed.to_owned()));
    }
    Ok(out)
}

/// Validates extra JSON request fields: size-capped, no app-owned or unsafe keys.
pub fn normalize_request_body(raw: &Map<String, Value>, label: &str) -> Result<Map<String, Value>, ProviderError> {
    let size = serde_json::to_string(raw).map_or(usize::MAX, |s| s.chars().count());
    if size > REQUEST_BODY_MAX_CHARS {
        return Err(invalid(format!("{label} must be at most {REQUEST_BODY_MAX_CHARS} characters")));
    }
    for key in raw.keys() {
        if UNSAFE_KEYS.contains(&key.as_str()) {
            return Err(invalid(format!("{label} has an unsafe key: {key}")));
        }
        if RESERVED_BODY_KEYS.contains(&key.as_str()) {
            return Err(invalid(format!("{label} must not set {key}: the app owns this field")));
        }
    }
    Ok(raw.clone())
}

/// Model-level header refusals include the transport headers.
pub fn normalize_model_headers(raw: &Map<String, Value>, label: &str) -> Result<Vec<(String, String)>, ProviderError> {
    normalize_headers(raw, label, MODEL_REFUSED_HEADERS)
}

/// Layers the provider's and model's extras over an encoded request: provider
/// then model body fields (reserved keys keep the app's value), provider
/// headers, then model headers over them.
pub struct CustomRewriter {
    pub config: CustomRequestConfig,
}

impl Rewriter for CustomRewriter {
    fn rewrite(&self, mut wire: WireRequest, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        let model = request.model.as_str();
        let model_extras = self.config.model_body.get(model).and_then(Value::as_object);
        if !self.config.request_body.is_empty() || model_extras.is_some() {
            let mut body: Value = serde_json::from_slice(&wire.body)
                .map_err(|_| invalid("request body is not JSON".to_owned()))?;
            if let Some(object) = body.as_object_mut() {
                for layer in [Some(&self.config.request_body), model_extras].into_iter().flatten() {
                    for (key, value) in layer {
                        if !RESERVED_BODY_KEYS.contains(&key.as_str()) && !UNSAFE_KEYS.contains(&key.as_str()) {
                            object.insert(key.clone(), value.clone());
                        }
                    }
                }
            }
            wire.body = serde_json::to_vec(&body).map_err(|_| invalid("request body is not JSON".to_owned()))?;
        }
        let mut set = |name: &str, value: &str| {
            wire.headers.retain(|(n, _)| !n.eq_ignore_ascii_case(name));
            wire.headers.push((name.to_owned(), value.to_owned()));
        };
        for (name, value) in &self.config.headers {
            set(name, value);
        }
        if let Some((_, headers)) = self.config.model_headers.iter().find(|(m, _)| m == model) {
            for (name, value) in headers {
                if !AUTH_HEADERS.contains(&name.to_ascii_lowercase().as_str())
                    && !MODEL_REFUSED_HEADERS.contains(&name.to_ascii_lowercase().as_str())
                {
                    set(name, value);
                }
            }
        }
        Ok(wire)
    }
}

/// The compat profiles name their provider with a `'static` id; a custom id
/// is interned once per distinct id for the life of the process.
fn interned(id: &str) -> &'static str {
    static IDS: Mutex<Option<HashSet<&'static str>>> = Mutex::new(None);
    let mut guard = IDS.lock().unwrap_or_else(PoisonError::into_inner);
    let ids = guard.get_or_insert_with(HashSet::new);
    if let Some(known) = ids.get(id) {
        return known;
    }
    let leaked: &'static str = Box::leak(id.to_owned().into_boxed_str());
    ids.insert(leaked);
    leaked
}

fn profile(id: &str, wire: Wire) -> CompatProfile {
    let mut profile = CompatProfile::plain(interned(id), "http://127.0.0.1/v1", CredentialKind::Keyless);
    profile.default_wire = wire;
    profile
}

fn config(profile: &CompatProfile, base_url: &str) -> CompatConfig {
    CompatConfig {
        base_url: Some(base_url.trim_end_matches('/').to_owned()),
        ..CompatConfig::for_profile(profile)
    }
}

/// The `openai-chat` protocol's codec for the endpoint at `base_url`.
pub fn chat_codec(id: &str, base_url: &str) -> Arc<dyn WireCodec> {
    let profile = profile(id, Wire::Chat);
    let config = config(&profile, base_url);
    Arc::new(CompatChatCodec::new(profile, config))
}

/// The `openai-responses` protocol's codec for the endpoint at `base_url`.
pub fn responses_codec(id: &str, base_url: &str) -> Arc<dyn WireCodec> {
    let profile = profile(id, Wire::Responses);
    let config = config(&profile, base_url);
    Arc::new(CompatResponsesCodec::new(profile, config, TransportKind::Http1))
}

/// A custom provider's adapter around the protocol's family codec. `api_key`
/// is empty for a keyless endpoint.
pub fn adapter(
    id: &str,
    family: Arc<dyn WireCodec>,
    http: Arc<dyn HttpSend>,
    config: CustomRequestConfig,
    api_key: &str,
    retry_policy: RetryPolicy,
) -> Result<HttpAdapter, ProviderError> {
    if !id.starts_with("custom-") || id.len() == "custom-".len() {
        return Err(invalid(format!("invalid custom provider id: {id}")));
    }
    let credential = (!api_key.is_empty()).then(|| ("authorization".to_owned(), format!("Bearer {api_key}")));
    Ok(HttpAdapter::new(
        ProviderId::from(id),
        Arc::new(RewriteCodec::new(family, CustomRewriter { config })),
        http,
        Arc::new(StaticCredential(credential)),
        retry_policy,
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn credentials_and_duplicates_are_refused_in_headers() {
        assert!(normalize_headers(&map(json!({"X-Api-Key": "k"})), "headers", &[]).is_err());
        assert!(normalize_headers(&map(json!({"A": "1", "a": "2"})), "headers", &[]).is_err());
        assert!(normalize_headers(&map(json!({"X-A": "line\nbreak"})), "headers", &[]).is_err());
        let ok = normalize_headers(&map(json!({"X-A": "  v\t"})), "headers", &[]).unwrap();
        assert_eq!(ok, vec![("X-A".to_owned(), "v".to_owned())]);
        assert!(normalize_model_headers(&map(json!({"Host": "x"})), "h").is_err());
    }

    #[test]
    fn app_owned_body_fields_are_refused() {
        assert!(normalize_request_body(&map(json!({"model": "x"})), "requestBody").is_err());
        assert!(normalize_request_body(&map(json!({"top_k": 5})), "requestBody").is_ok());
    }
}
