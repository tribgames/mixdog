//! The adapter each provider id stands for (`instantiateProvider` and the
//! provider modules of `providers/registry.mjs`), built from the provider's
//! config entry, its credentials and the host's seams.
//!
//! Admission and account rotation wrap sends above the adapter, so each
//! built adapter is the plain one. `mixdog-local` is registered over the host's
//! managed runtime (`BuilderEnv::local`): its server, and so its endpoint, starts on a send
//! (`providers::local::RegisteredAdapter`).

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_protocol::ids::ProviderId;
use mixdog_rt::CpuBulk;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::keys::ApiKeyStore;
use super::keys::KeyConfig;
use super::keys::ProviderKey;
use super::providers::OAUTH_PROVIDER_NAMES;
use super::providers::ProviderBuilder;
use crate::accounts::AccountStore;
use crate::accounts::CredentialState;
use crate::accounts::rotation::AccountRotation;
use crate::catalog::CachedModelInfo;
use crate::catalog::ListingLookup;
use crate::oauth::CredentialFile;
use crate::oauth::Pace;
use crate::providers::compat::login::opencode_go::OpenCodeGoAuth;
use crate::providers::compat::login::opencode_go::RefreshError;
use crate::oauth::Probe;
use crate::providers::anthropic::AnthropicAdapter;
use crate::providers::anthropic::AnthropicConfig;
use crate::providers::anthropic::CapsLookup;
use crate::providers::anthropic::OAuthSession;
use crate::providers::compat::adapter::CompatAdapter;
use crate::providers::compat::adapter::RouteInputs;
use crate::providers::compat::chat::CompatChatCodec;
use crate::providers::compat::chat::CompatConfig;
use crate::providers::compat::creds::MimoCredentials;
use crate::providers::compat::creds::OpenCodeGoCredentials;
use crate::oauth::CredentialIo;
use crate::providers::compat::profile::CompatProfile;
use crate::providers::cursor::CursorAdapter;
use crate::providers::cursor::auth::ApiKeyAccess;
use crate::providers::cursor::auth::FileAccess;
use super::gateway::GatewayAdapter;
use super::gateway::GatewayHttp;
use super::gateway::ResponsesEngine;
use super::gateway::Sdk;
use super::gateway::WirePick;
use super::multiwire::MultiWireAdapter;
use crate::providers::compat::responses::CompatResponsesCodec;
use super::vertex_metadata;
use crate::providers::anthropic::AnthropicCodec;
use crate::providers::anthropic::Flavor;
use crate::providers::compat::profile::Wire;
use crate::providers::connect::rewrite::HttpAdapter;
use crate::providers::connect::rewrite::RewriteCodec;
use crate::providers::connect::rewrite::Credential;
use crate::providers::custom;
use crate::providers::custom::CustomRequestConfig;
use crate::providers::custom::listing::CustomListing;
use mixdog_core_api::domain::provider::ModelListing;
use crate::providers::custom::CustomRewriter;
use crate::providers::custom::Protocol;
use crate::providers::devin::DevinAdapter;
use crate::providers::devin::auth::FileSessionToken;
use crate::providers::google;
use crate::providers::google::auth::RequestAuth;
use crate::providers::google::auth::antigravity::FileTokenStore;
use crate::providers::google::auth::vertex;
use crate::providers::google::serving::VertexPlace;
use crate::providers::google::serving::env_location;
use crate::providers::google::traits::ModelTraits;
use crate::providers::grok;
use crate::providers::grok::auth::GrokCredential;
use crate::providers::key_source::ApiKeySource;
use crate::providers::openai::adapter::AdapterLinks;
use crate::providers::openai::adapter::Credential as OpenAiBearer;
use crate::providers::openai::adapter::CredentialSource;
use crate::providers::openai::adapter::OpenAiAdapter;
use crate::providers::openai::adapter::SessionContext;
use crate::client_versions::Dialect;
use crate::providers::openai::codec::OpenAiCodec;
use super::versioned::VersionedAdapter;
use crate::providers::openai::config::CodexIdentity;
use crate::providers::openai::config::ModelFactsSource;
use crate::providers::openai::config::OpenAiConfig;
use crate::providers::openai::config::WireContext;
use crate::providers::openai::oauth::OpenAiOAuth;
use crate::transport::BidiOpen;
use crate::transport::HttpSend;
use crate::transport::preconnect::Preconnect;
use crate::transport::preconnect::Setting;
use crate::transport::WsDial;

/// What the host supplies to every adapter.
#[derive(Clone)]
pub struct BuilderEnv {
    pub http: Arc<dyn HttpSend>,
    pub bidi: Arc<dyn BidiOpen>,
    pub dial: Arc<dyn WsDial>,
    pub keys: ApiKeyStore,
    /// Credential files of the OAuth providers (the `default` account's).
    pub accounts: AccountStore,
    /// Model capabilities from the Anthropic `/v1/models` catalog.
    pub anthropic_caps: CapsLookup,
    /// Gemini/Vertex model traits.
    pub google_traits: Arc<dyn ModelTraits>,
    pub openai_facts: Arc<dyn ModelFactsSource>,
    /// The per-process OpenAI request context (turn-state tokens).
    pub openai_context: Arc<SessionContext>,
    pub codex_identity: CodexIdentity,
    /// The clock and sleeper of the token refreshes.
    pub pace: Arc<dyn Pace>,
    pub gzip_lane: CpuBulk,
    /// The mixdog build, sent as the client version where a dialect sends one.
    pub client_version: String,
    pub grok_client_version: Option<crate::client_versions::Live>,
    pub cursor_client_version: Option<crate::client_versions::Live>,
    pub antigravity_client_version: crate::client_versions::Live,
    /// The live versions the dialects gate on: warmed before a send of theirs, and where a 426
    /// teaches Grok a minimum (None: no dialect warms).
    pub client_versions: Option<Arc<crate::client_versions::ClientVersions>>,
    /// The tables the adapters' listing steps (enrichment, sanitizer) read;
    /// the catalog service publishes into the same handle.
    pub listing: ListingLookup,
    /// Process environment (`GOOGLE_APPLICATION_CREDENTIALS`, project and
    /// location variables, custom `apiKeyEnv`).
    pub env: Arc<dyn super::keys::Environment>,
    /// The user's home directory and `%APPDATA%`-style base for gcloud's ADC.
    pub home_dir: PathBuf,
    /// The lane the gcloud configuration and ADC files are read on.
    pub io: CredentialIo,
    /// `providerAvailable`: names a Developer option currently gates off.
    pub gated_off: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    /// The managed local runtime `mixdog-local` is registered over (`ensureLocalProviderServer`,
    /// `installedLocalProviderModels`); a host without one cannot enable that provider.
    pub local: Option<Arc<dyn crate::providers::local::LocalRuntime>>,
}

/// A built custom provider and its listing (see [`DefaultProviderBuilder::build_custom_parts`]).
pub struct CustomParts {
    pub adapter: Arc<dyn ProviderAdapter>,
    pub listing: Arc<CustomListing>,
}

pub struct DefaultProviderBuilder {
    env: BuilderEnv,
    /// The metadata server's project, probed once per process (a negative
    /// outcome is kept too).
    metadata_project: tokio::sync::OnceCell<Option<String>>,
    /// The stored-row capability of each built adapter whose class has `getCachedModelInfo`, by provider name.
    capabilities: std::sync::Mutex<HashMap<String, Arc<dyn CachedModelInfo>>>,
    /// The roster walk of every custom provider's key pool (quota strikes, session bindings).
    key_rotation: AccountRotation,
}

impl DefaultProviderBuilder {
    pub fn new(env: BuilderEnv) -> Self {
        let key_rotation = AccountRotation::new(env.accounts.clone(), Arc::new(super::key_pool::NoMeter), env.pace.clone());
        Self { env, metadata_project: tokio::sync::OnceCell::new(), capabilities: std::sync::Mutex::default(), key_rotation }
    }

    /// A custom provider with additional API keys sends through its key roster (`createCustomKeyPoolProvider`);
    /// one without sends with its primary key alone.
    async fn build_custom_pool(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        let primary = self.build_custom(name, cfg)?;
        let ids: Vec<String> = cfg
            .get(super::providers::CUSTOM_KEY_IDS)
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default();
        if ids.is_empty() {
            return Ok(primary);
        }
        let mut keys = Vec::with_capacity(ids.len());
        for id in ids {
            let engine = self.custom_key_engine(name, cfg, &id).await;
            keys.push((id, engine));
        }
        Ok(Arc::new(super::key_pool::KeyPoolAdapter::new(name, primary, keys, self.key_rotation.clone())))
    }

    /// `customKeyEngine`: the provider's configuration with the additional key as its only key source.
    async fn custom_key_engine(&self, name: &str, cfg: &Value, id: &str) -> super::key_pool::KeyEngine {
        let key = self
            .env
            .keys
            .read_custom(name, id)
            .await
            .map_err(|error| format!("An additional API key of {name} could not be read: {error}."))?;
        if key.is_empty() {
            return Err(format!("An additional API key of {name} is not readable; enter it again in its settings."));
        }
        let mut config = cfg.clone();
        if let Some(object) = config.as_object_mut() {
            // The key is the only source: an environment variable names the primary key alone.
            object.shift_remove("apiKeyEnv");
            object.shift_remove(super::providers::CUSTOM_KEY_IDS);
            object.insert("apiKey".into(), json!(key));
        }
        self.build_custom_parts(name, &config).map(|parts| parts.adapter)
    }
}

// The two readers below are bodies of lane jobs (`CredentialIo::read_job`).
#[allow(clippy::disallowed_methods, reason = "body of a lane job")]
fn read_text(path: &std::path::Path) -> std::io::Result<String> {
    std::fs::read_to_string(path)
}

/// [`read_text`] of a credential file (the gcloud login).
fn read_credential_text(path: &std::path::Path) -> std::io::Result<String> {
    #[cfg(feature = "count-work")]
    crate::work::credential_read();
    read_text(path)
}

/// The `project =` of the `[core]` section of the gcloud configuration `named`
/// (else the active one, else `default`) under `dir`.
fn read_gcloud_project(dir: &std::path::Path, named: String) -> Option<String> {
    let mut name = named;
    if name.is_empty() {
        name = read_text(&dir.join("active_config")).map(|s| s.trim().to_owned()).unwrap_or_default();
    }
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) {
        name = "default".into();
    }
    let raw = read_text(&dir.join("configurations").join(format!("config_{name}"))).ok()?;
    let mut section = String::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(inner) = trimmed.strip_prefix('[').and_then(|t| t.strip_suffix(']')) {
            section = inner.trim().to_lowercase();
        }
        if section == "core" {
            if let Some(value) = trimmed.strip_prefix("project").map(str::trim_start).and_then(|t| t.strip_prefix('=')) {
                return Some(value.trim().to_owned());
            }
        }
    }
    None
}

/// What the gcloud login location held.
enum AdcRead {
    Found { raw: String, path: String },
    /// No `GOOGLE_APPLICATION_CREDENTIALS`, and no file in gcloud's directory.
    NoLogin,
}

const ADC_LOGIN_HINT: &str = "Run `gcloud auth application-default login`.";

/// `credential.kind` of a parsed ADC file.
fn credential_type(credential: &vertex::Credential) -> &'static str {
    match &credential.kind {
        vertex::Kind::Impersonated { .. } => "impersonated_service_account",
        vertex::Kind::Grant(vertex::Grant::ServiceAccount { .. }) => "service_account",
        vertex::Kind::Grant(vertex::Grant::AuthorizedUser { .. }) => "authorized_user",
    }
}

/// The credential type a `Vertex AI does not support "<type>" credentials` refusal names.
fn unsupported_type(message: &str) -> Option<String> {
    let rest = message.strip_prefix("Vertex AI does not support \"")?;
    rest.split_once('"').map(|(kind, _)| kind.to_owned())
}

fn text<'a>(cfg: &'a Value, key: &str) -> Option<&'a str> {
    cfg.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn flag(cfg: &Value, key: &str) -> Option<bool> {
    cfg.get(key).and_then(Value::as_bool)
}

/// A provider build fails, with this text, when the keychain read for its key never ran: an empty
/// key would instead report the provider as not configured. A read that ran and found nothing is
/// not an error here.
fn unread_key(provider: &str, error: &super::keys::VaultError) -> String {
    format!("The API key for {provider} could not be read: {error}.")
}

fn key_config(cfg: &Value) -> KeyConfig {
    KeyConfig {
        api_key: cfg.get("apiKey").and_then(Value::as_str).map(str::to_owned),
        api_key_env: cfg.get("apiKeyEnv").and_then(Value::as_str).map(str::to_owned),
    }
}

fn string_pairs(cfg: &Value, key: &str) -> Vec<(String, String)> {
    cfg.get(key)
        .and_then(Value::as_object)
        .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned()))).collect())
        .unwrap_or_default()
}

fn reauth(message: &str) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
    err.reauth_required = true;
    err.message = message.to_owned();
    err
}

/// The key a login stored in a credential file (`apiKey` or `accessToken`),
/// re-read on every send so a new sign-in is picked up.
struct FileKey {
    file: CredentialFile,
    provider: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredKey {
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
}

impl FileKey {
    async fn read(&self) -> Result<String, ProviderError> {
        match self.file.load::<StoredKey>().await {
            Probe::Present(stored) => stored
                .api_key
                .or(stored.access_token)
                .filter(|k| !k.is_empty())
                .ok_or_else(|| reauth(&format!("not signed in to {}", self.provider))),
            Probe::Absent => Err(reauth(&format!("not signed in to {}", self.provider))),
            Probe::Unreadable => {
                let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
                err.message = format!("the stored {} login cannot be read right now", self.provider);
                Err(err)
            }
        }
    }
}

#[async_trait]
impl ApiKeySource for FileKey {
    async fn key(&self) -> Result<String, ProviderError> {
        self.read().await
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        self.read().await
    }
}

/// A custom provider's credential header, read per request: `None` for a
/// keyless endpoint, and for a missing key outside env mode. In env mode an
/// unset variable fails before any request is sent, and a 401 re-reads it.
struct CustomKey {
    source: Option<Arc<ProviderKey>>,
    env: Option<String>,
    header: &'static str,
    bearer: bool,
}

#[async_trait]
impl Credential for CustomKey {
    async fn header(&self, force_refresh: bool) -> Result<Option<(String, String)>, ProviderError> {
        let Some(source) = &self.source else { return Ok(None) };
        let read = if force_refresh { source.reload().await } else { source.key().await };
        match read {
            Ok(key) => {
                let value = if self.bearer { format!("Bearer {key}") } else { key };
                Ok(Some((self.header.to_owned(), value)))
            }
            Err(_) => match &self.env {
                Some(var) => {
                    let mut err = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
                    err.message = format!("API key environment variable {var} is not set");
                    Err(err)
                }
                None => Ok(None),
            },
        }
    }

    fn refreshable(&self) -> bool {
        self.source.is_some()
    }
}

/// A gateway key in one header (`x-api-key`, or `authorization` as a bearer), re-read per request; a 401 reloads
/// it.
struct KeyHeader {
    source: Arc<dyn ApiKeySource>,
    header: &'static str,
    bearer: bool,
}

#[async_trait]
impl Credential for KeyHeader {
    async fn header(&self, force_refresh: bool) -> Result<Option<(String, String)>, ProviderError> {
        let key = if force_refresh { self.source.reload().await? } else { self.source.key().await? };
        Ok(Some((self.header.to_owned(), if self.bearer { format!("Bearer {key}") } else { key })))
    }

    fn refreshable(&self) -> bool {
        true
    }
}

/// OpenCode Go's Gemini route: the access token as a bearer and as the Google key (`OpenCodeGoGeminiEngine`).
struct GoBearerAuth(Arc<dyn ApiKeySource>);

#[async_trait]
impl RequestAuth for GoBearerAuth {
    async fn authorize(&self) -> Result<google::auth::Authorization, ProviderError> {
        let token = self.0.key().await?;
        Ok(google::auth::Authorization {
            headers: vec![("authorization".into(), format!("Bearer {token}")), ("x-goog-api-key".into(), token)],
            identity: String::new(),
        })
    }

    async fn rejected(&self, rejected: &google::auth::Authorization) -> bool {
        match self.0.reload().await {
            Ok(token) => rejected.headers.iter().all(|(_, v)| *v != token),
            Err(_) => false,
        }
    }
}

/// A key that never changes.
struct FixedKey(String);

#[async_trait]
impl ApiKeySource for FixedKey {
    async fn key(&self) -> Result<String, ProviderError> {
        Ok(self.0.clone())
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        Ok(self.0.clone())
    }
}

fn custom_invalid(message: &str) -> String {
    format!("[custom-provider] {message}")
}

fn wire_of_name(name: &str) -> Option<Wire> {
    match name {
        "chat" => Some(Wire::Chat),
        "responses" => Some(Wire::Responses),
        "messages" => Some(Wire::Messages),
        _ => None,
    }
}

const CUSTOM_WIRE_ORDER: [(&str, Wire); 3] = [("chat", Wire::Chat), ("responses", Wire::Responses), ("messages", Wire::Messages)];

/// `normalizeWires`: the wires the endpoint serves (the protocol's own
/// included), in `chat, responses, messages` order; absent means the
/// protocol's wire only.
fn custom_wires(cfg: &Value, protocol: &Protocol, protocol_wire: Wire) -> Result<Vec<Wire>, String> {
    let Some(raw) = cfg.get("wires") else { return Ok(vec![protocol_wire]) };
    if *protocol == Protocol::Anthropic {
        return Err(custom_invalid("wires requires an 'openai-chat' or 'openai-responses' protocol"));
    }
    let list = raw.as_array().filter(|a| !a.is_empty()).ok_or_else(|| custom_invalid("wires must be a non-empty array"))?;
    let mut seen: Vec<Wire> = Vec::new();
    for item in list {
        let wire = item.as_str().and_then(wire_of_name);
        let Some(wire) = wire else {
            let shown = match item {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            return Err(custom_invalid(&format!("wires has unsupported wire: {shown}")));
        };
        if seen.contains(&wire) {
            return Err(custom_invalid(&format!("wires has duplicate wire: {}", item.as_str().unwrap_or_default())));
        }
        seen.push(wire);
    }
    if !seen.contains(&protocol_wire) {
        let own = CUSTOM_WIRE_ORDER.iter().find(|(_, w)| *w == protocol_wire).map_or("", |(n, _)| n);
        return Err(custom_invalid(&format!("wires must include the protocol wire: {own}")));
    }
    Ok(CUSTOM_WIRE_ORDER.iter().map(|(_, w)| *w).filter(|w| seen.contains(w)).collect())
}

/// `normalizeModelWires`: the per-model wire override, each one of the served wires.
fn custom_model_wires(
    cfg: &Value,
    protocol: &Protocol,
    served: &[Wire],
) -> Result<std::collections::HashMap<String, Wire>, String> {
    let mut out = std::collections::HashMap::new();
    let Some(raw) = cfg.get("modelWires") else { return Ok(out) };
    if *protocol == Protocol::Anthropic {
        return Err(custom_invalid("modelWires requires an 'openai-chat' or 'openai-responses' protocol"));
    }
    let map = raw.as_object().ok_or_else(|| custom_invalid("modelWires must be an object"))?;
    for (model, wire) in map {
        let wire = wire.as_str().and_then(wire_of_name).filter(|w| served.contains(w));
        let Some(wire) = wire else {
            let names: Vec<&str> = CUSTOM_WIRE_ORDER.iter().filter(|(_, w)| served.contains(w)).map(|(n, _)| *n).collect();
            return Err(custom_invalid(&format!(
                "modelWires[{model}] must be one of the served wires: {}",
                names.join(", ")
            )));
        };
        out.insert(model.clone(), wire);
    }
    Ok(out)
}

/// OpenCode Go's access token, refreshed through the credential file's
/// single-flight when it nears expiry; `reload` (after a 401) refreshes now.
struct OpenCodeKey(OpenCodeGoAuth);

impl OpenCodeKey {
    async fn token(&self, force: bool) -> Result<String, ProviderError> {
        match self.0.ensure_fresh(force).await {
            Ok(credentials) => Ok(credentials.access_token),
            Err(RefreshError::Reauth(message, _)) => Err(reauth(&format!("OpenCode sign-in expired: {message}"))),
            Err(RefreshError::Failed(message, _)) => {
                let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
                err.message = message;
                Err(err)
            }
        }
    }
}

#[async_trait]
impl ApiKeySource for OpenCodeKey {
    async fn key(&self) -> Result<String, ProviderError> {
        self.token(false).await
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        self.token(true).await
    }
}

/// The wire `openai` and `openai-oauth` speak (`MIXDOG_OAI_TRANSPORT`):
/// `http-sse` and its spellings pin HTTP/SSE; every other mode (`auto`,
/// `ws-full`, `ws-delta`, unset or unknown) is WebSocket-first, and the
/// HTTP replay on a WebSocket failure is decided above the adapter.
fn openai_transport(raw: Option<String>) -> TransportKind {
    let v = raw.unwrap_or_default().trim().to_lowercase();
    let v: String = v.split(|c: char| c.is_whitespace() || c == '_').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-");
    match v.as_str() {
        "http-sse" | "httpsse" | "http" | "sse" | "http/sse" => TransportKind::Http1,
        _ => TransportKind::WebSocket,
    }
}

/// The OpenAI public API's bearer: the configured or stored key.
struct OpenAiKey(Arc<ProviderKey>);

#[async_trait]
impl CredentialSource for OpenAiKey {
    async fn current(&self) -> Result<OpenAiBearer, ProviderError> {
        Ok(OpenAiBearer { bearer: self.0.key().await?, account_id: None })
    }
    async fn after_rejection(&self, rejected: &OpenAiBearer) -> Result<Option<OpenAiBearer>, ProviderError> {
        let key = self.0.reload().await?;
        Ok((key != rejected.bearer).then_some(OpenAiBearer { bearer: key, account_id: None }))
    }
}

fn now_ms_u64() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn adapter<T: ProviderAdapter + 'static>(a: T) -> Arc<dyn ProviderAdapter> {
    Arc::new(a)
}

impl DefaultProviderBuilder {
    fn file(&self, provider: &str) -> Result<CredentialFile, String> {
        self.env.accounts.credential_file(provider, "default").map_err(|e| e.to_string())
    }

    /// Declares the stored-row capability of the adapter built under `name` (see `cached_model_info`).
    fn declare(&self, name: &str, capability: Arc<dyn CachedModelInfo>) {
        self.capabilities.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(name.to_owned(), capability);
    }

    fn key_source(&self, provider: &str, cfg: &Value) -> Arc<ProviderKey> {
        ProviderKey::primary(self.env.keys.clone(), provider, key_config(cfg))
    }

    async fn build_anthropic(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        let mut config = AnthropicConfig::new(self.env.anthropic_caps.clone());
        if let Some(url) = text(cfg, "baseURL") {
            config.base_url = url.trim_end_matches('/').to_owned();
        }
        config.disable_beta_headers = flag(cfg, "disableBetaHeaders").unwrap_or(false);
        config.extra_headers = string_pairs(cfg, "extraHeaders");
        config.listing = self.env.listing.clone();
        let http = self.env.http.clone();
        if name == "anthropic" {
            let keys = self.key_source(name, cfg);
            // The API-key provider posts through the Anthropic client, the user's headers as its `defaultHeaders`
            // (anthropic.mjs:116-125).
            let http = Arc::new(GatewayHttp::new(http).through_sdk(Sdk::Anthropic, &config.extra_headers));
            return Ok(adapter(AnthropicAdapter::api_key(config, http, keys, self.env.gzip_lane)));
        }
        let session = Arc::new(OAuthSession::new(self.file(name)?, http.clone()));
        let enterprise = session.stored().await.map(|s| s.is_enterprise()).unwrap_or(false);
        Ok(adapter(
            AnthropicAdapter::oauth(config, http, session, enterprise, self.env.gzip_lane)
                .with_settings(self.settings())
                .with_preconnect(self.preconnect()),
        ))
    }

    /// The process settings the wire reads, from the process's request context.
    fn settings(&self) -> Setting {
        let context = self.env.openai_context.clone();
        Arc::new(move |name| context.var(name))
    }

    /// The socket warm-up of the providers that run one, on the process's request clock and settings.
    fn preconnect(&self) -> Preconnect {
        let clock = self.env.openai_context.clone();
        Preconnect::new(self.env.http.clone(), Arc::new(move || clock.now_unix_ms()), self.settings())
    }

    fn build_openai(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        let context: Arc<dyn WireContext> = self.env.openai_context.clone();
        let facts = self.env.openai_facts.clone();
        let transport = openai_transport(self.env.env.var("MIXDOG_OAI_TRANSPORT"));
        let (config, credentials): (OpenAiConfig, Arc<dyn CredentialSource>) = if name == "openai" {
            (
                OpenAiConfig::api_key(flag(cfg, "store").unwrap_or(true), facts, context),
                Arc::new(OpenAiKey(self.key_source(name, cfg))),
            )
        } else {
            (
                OpenAiConfig::codex(false, true, self.env.codex_identity.clone(), facts, context),
                Arc::new(OpenAiOAuth::new(self.file(name)?, self.env.http.clone())),
            )
        };
        Ok(adapter(OpenAiAdapter::new(
            ProviderId::from(name),
            OpenAiCodec::new(config, transport),
            AdapterLinks {
                http: self.env.http.clone(),
                dial: self.env.dial.clone(),
                compress_lane: self.env.gzip_lane,
                credentials,
                context: self.env.openai_context.clone(),
                listing: self.env.listing.clone(),
            },
        )))
    }

    fn compat_config(
        &self,
        profile: &CompatProfile,
        cfg: &Value,
        base_url: Option<String>,
        login_headers: Vec<(String, String)>,
    ) -> CompatConfig {
        let mut extra_headers = string_pairs(cfg, "extraHeaders");
        extra_headers.extend(login_headers);
        CompatConfig {
            base_url: base_url.or_else(|| text(cfg, "baseURL").map(|u| u.trim_end_matches('/').to_owned())),
            client_version: self.env.client_version.clone(),
            extra_headers,
            ..CompatConfig::for_profile(profile)
        }
    }

    /// A gateway's Anthropic Messages engine (`GatewayMessagesEngine`, `OpenCodeGoMessagesEngine`,
    /// `CommandCodeMessagesEngine`): the API-key Anthropic codec on the gateway's base, beta headers off, the
    /// gateway's identifying headers and the user's own on every request.
    fn gateway_messages_engine(
        &self,
        name: &str,
        base: String,
        credential: Arc<dyn Credential>,
        headers: Vec<(String, String)>,
        http: Arc<dyn crate::transport::HttpSend>,
    ) -> HttpAdapter {
        let mut config = AnthropicConfig::new(self.env.anthropic_caps.clone());
        config.base_url = base;
        config.disable_beta_headers = true;
        // The Anthropic SDK's `accept`, which the gateway engines send ahead of their own headers.
        config.extra_headers = std::iter::once(("accept".to_owned(), "application/json".to_owned())).chain(headers).collect();
        config.listing = self.env.listing.clone();
        let policy = AnthropicAdapter::api_key(config.clone(), http.clone(), Arc::new(FixedKey(String::new())), self.env.gzip_lane)
            .retry_policy()
            .clone();
        HttpAdapter::new(ProviderId::from(name), Arc::new(AnthropicCodec::new(Flavor::ApiKey, config)), http, credential, policy)
    }

    /// xAI's API mode (`useXaiResponsesApi`): Responses unless the request, config or environment names Chat.
    fn xai_wire(&self, cfg: &Value) -> Wire {
        let raw = text(cfg, "apiMode")
            .or_else(|| text(cfg, "xaiApiMode"))
            .map(str::to_owned)
            .or_else(|| self.env.env.var("MIXDOG_XAI_API_MODE"))
            .or_else(|| self.env.env.var("MIXDOG_XAI_RESPONSES"));
        match raw.map(|v| v.trim().to_lowercase()) {
            Some(mode) if ["0", "false", "off", "chat", "chat-completions", "chat_completions"].contains(&mode.as_str()) => Wire::Chat,
            _ => Wire::Responses,
        }
    }

    async fn build_compat(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        let mut login_headers: Vec<(String, String)> = Vec::new();
        let (profile, key, base_url): (CompatProfile, Arc<dyn ApiKeySource>, Option<String>) = match name {
            "xai" => (CompatProfile::xai(), self.key_source(name, cfg), None),
            "deepseek" => (CompatProfile::deepseek(), self.key_source(name, cfg), None),
            "openrouter" => (CompatProfile::openrouter(), self.key_source(name, cfg), None),
            "mimo-oauth" => {
                let file = self.file(name)?;
                // The gateway the login named; the default when none was stored.
                let base = match file.load::<MimoCredentials>().await {
                    Probe::Present(c) => Some(c.base_url().to_owned()),
                    _ => None,
                };
                (CompatProfile::mimo_oauth(), Arc::new(FileKey { file, provider: "mimo-oauth" }), base)
            }
            "command-code-oauth" => (
                CompatProfile::command_code_oauth(),
                Arc::new(FileKey { file: self.file(name)?, provider: "command-code-oauth" }),
                None,
            ),
            "muse-code-oauth" => (
                CompatProfile::muse_code_oauth(),
                Arc::new(FileKey { file: self.file(name)?, provider: "muse-code-oauth" }),
                None,
            ),
            "opencode-go-oauth" => {
                let file = self.file(name)?;
                // The org the login named rides every request (`x-org-id`); a
                // new login rebuilds the adapter.
                if let Probe::Present(stored) = file.load::<OpenCodeGoCredentials>().await {
                    login_headers = stored.headers().into_iter().filter(|(n, _)| n != "authorization").collect();
                }
                let auth = OpenCodeGoAuth::new(self.env.http.clone(), self.env.pace.clone(), file);
                (CompatProfile::opencode_go(), Arc::new(OpenCodeKey(auth)), None)
            }
            other => return Err(format!("unknown enabled provider: {other}")),
        };
        let config = self.compat_config(&profile, cfg, base_url, login_headers);
        // The OpenAI client's `defaultHeaders`: the gateway's own headers and the user's (MiMo's through its
        // `extraHeaders`, mimo-oauth.mjs:172).
        let defaults: Vec<(String, String)> =
            profile.headers.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).chain(config.extra_headers.iter().cloned()).collect();
        let http: Arc<dyn crate::transport::HttpSend> = Arc::new(GatewayHttp::new(self.env.http.clone()).through_sdk(Sdk::OpenAi, &defaults));
        let codec = CompatChatCodec::new(profile.clone(), config.clone());
        let chat_base = codec.base_url().to_owned();
        let model_wires = cfg
            .get("modelWires")
            .and_then(Value::as_object)
            .map(|map| map.iter().filter_map(|(m, w)| Some((m.clone(), Wire::parse(w.as_str()?)?))).collect())
            .unwrap_or_default();
        let routing = RouteInputs { model_wires, catalog: None };
        let caches_model_info = profile.listing.caches_model_info;
        let account = Arc::new(
            CompatAdapter::new(codec, http.clone(), Some(key.clone()))
                .with_routing(routing)
                .with_listing_lookup(self.env.listing.clone()),
        );
        if caches_model_info {
            self.declare(name, account.clone());
        }
        let responses = || -> Arc<dyn ProviderAdapter> {
            let codec = CompatResponsesCodec::new(profile.clone(), config.clone(), TransportKind::Http1);
            Arc::new(ResponsesEngine::new(account.clone(), codec))
        };
        // The gateway's own identifying headers, then the user's (`extraHeaders`), ride every wire.
        let mut identifying: Vec<(String, String)> =
            profile.headers.iter().filter(|(k, _)| !k.eq_ignore_ascii_case("accept")).map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        identifying.extend(config.extra_headers.iter().cloned());
        let keyed = |header: &'static str, bearer: bool| -> Arc<dyn Credential> { Arc::new(KeyHeader { source: key.clone(), header, bearer }) };
        // The Messages engines post through the Anthropic client, the gateway's headers as its `defaultHeaders`.
        let anthropic_http = || GatewayHttp::new(self.env.http.clone()).through_sdk(Sdk::Anthropic, &identifying);
        // The Anthropic SDK appends `/v1/messages` to the base (`messagesBaseFromOpenAIBase`).
        let messages_base = |base: &str| -> String {
            let base = base.trim_end_matches('/');
            match base.len().checked_sub(3).filter(|at| base.is_char_boundary(*at)) {
                Some(at) if base[at..].eq_ignore_ascii_case("/v1") => base[..at].to_owned(),
                _ => base.to_owned(),
            }
        };
        let (engines, pick, session_header): (Vec<(Wire, Arc<dyn ProviderAdapter>)>, WirePick, bool) = match name {
            "xai" => (vec![(Wire::Responses, responses())], WirePick::Fixed(self.xai_wire(cfg)), false),
            "muse-code-oauth" => (vec![(Wire::Responses, responses())], WirePick::Fixed(Wire::Responses), false),
            "deepseek" => {
                let base = format!("{}/anthropic", messages_base(&chat_base));
                let engine = self.gateway_messages_engine(name, base, keyed("x-api-key", false), identifying.clone(), Arc::new(anthropic_http()));
                (vec![(Wire::Messages, Arc::new(engine))], WirePick::Routed, false)
            }
            "openrouter" => {
                let engine = self.gateway_messages_engine(name, messages_base(&chat_base), keyed("authorization", true), identifying.clone(), Arc::new(anthropic_http()));
                (vec![(Wire::Messages, Arc::new(engine)), (Wire::Responses, responses())], WirePick::Routed, false)
            }
            "command-code-oauth" => {
                // The key as `x-api-key` and, right after it, as a bearer (`CommandCodeMessagesEngine`).
                let mirrored: Arc<dyn crate::transport::HttpSend> = Arc::new(anthropic_http().mirroring_key_as_bearer());
                let engine = self.gateway_messages_engine(name, messages_base(&chat_base), keyed("x-api-key", false), identifying.clone(), mirrored);
                (vec![(Wire::Messages, Arc::new(engine)), (Wire::Responses, responses())], WirePick::Routed, false)
            }
            "opencode-go-oauth" => {
                let messages = self.gateway_messages_engine(name, messages_base(&chat_base), keyed("x-api-key", false), identifying.clone(), Arc::new(anthropic_http()));
                // The generateContent routes live under `.../go/v1`, not the organization's chat base
                // (`opencode-go.mjs` `_geminiEngine`); the Gemini codec writes `/v1beta`.
                let origin = chat_base.strip_suffix("/openai/v1").unwrap_or(&chat_base).to_owned();
                let gemini_http: Arc<dyn crate::transport::HttpSend> =
                    Arc::new(
                        GatewayHttp::new(self.env.http.clone())
                            .moving_path("/v1beta/models/", "/v1/models/")
                            .plain_system_instruction()
                            .with_headers(identifying.clone()),
                    );
                let gemini = google::adapter::GoogleAdapter::new(
                    google::codec::GoogleCodec::gemini(origin, self.env.google_traits.clone()),
                    google::policy::gemini(),
                    gemini_http,
                    Arc::new(GoBearerAuth(key.clone())),
                    String::new(),
                );
                let engines: Vec<(Wire, Arc<dyn ProviderAdapter>)> =
                    vec![(Wire::Responses, responses()), (Wire::Messages, Arc::new(messages)), (Wire::Gemini, Arc::new(gemini))];
                (engines, WirePick::Routed, true)
            }
            // MiMo is reached over Chat only.
            _ => return Ok(account),
        };
        // The Messages ceiling: the roster row's `outputTokens`, and for DeepSeek and OpenRouter the shared
        // catalog's after it (`WireGatewayProvider._modelMaxOutputTokens`; OpenCode Go and Command Code read their
        // roster alone).
        let rows: Arc<dyn CachedModelInfo> = account.clone();
        let catalog = matches!(name, "deepseek" | "openrouter").then(|| (self.env.listing.clone(), name.to_owned()));
        let ceiling = move |model: &str| -> Option<u32> {
            let listed = rows.cached_row(model).and_then(|row| row.get("outputTokens").and_then(Value::as_u64)).filter(|n| *n > 0);
            let declared = listed.or_else(|| catalog.as_ref().and_then(|(lookup, provider)| lookup.output_tokens(provider, model)));
            declared.map(|n| u32::try_from(n).unwrap_or(u32::MAX))
        };
        let gateway = GatewayAdapter::new(account, engines, pick).with_messages_ceiling(Arc::new(ceiling));
        Ok(Arc::new(if session_header { gateway.with_session_header() } else { gateway }))
    }

    async fn build_gemini(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        // A key that cannot be read fails the build; the key itself is read at each request and again after a 401.
        self.env.keys.resolve(name, &key_config(cfg)).await.map_err(|e| unread_key(name, &e))?;
        Ok(adapter(
            google::gemini_keyed(self.key_source(name, cfg), self.env.http.clone(), self.env.google_traits.clone())
                .with_listing_lookup(self.env.listing.clone())
                .with_preconnect(self.preconnect()),
        ))
    }

    fn gcloud_dir(&self) -> PathBuf {
        let var = |name: &str| self.env.env.var(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        if let Some(dir) = var("CLOUDSDK_CONFIG") {
            return PathBuf::from(dir);
        }
        match var("APPDATA").filter(|_| cfg!(windows)) {
            Some(appdata) => PathBuf::from(appdata).join("gcloud"),
            None => self.env.home_dir.join(".config").join("gcloud"),
        }
    }

    /// The `project =` of the `[core]` section of gcloud's active configuration.
    async fn gcloud_config_project(&self) -> Option<String> {
        let dir = self.gcloud_dir();
        let named = self.env.env.var("CLOUDSDK_ACTIVE_CONFIG_NAME").map(|v| v.trim().to_owned()).unwrap_or_default();
        self.env
            .io
            .read_job(move |_| Ok(read_gcloud_project(&dir, named)))
            .await
            .ok()
            .flatten()
            .filter(|p| !p.is_empty())
    }

    /// `adcLocation` + `readAdcFile`: `GOOGLE_APPLICATION_CREDENTIALS`, when
    /// set, is the only source (its missing file is an error); else gcloud's.
    async fn adc_text(&self) -> Result<AdcRead, String> {
        let explicit = self.env.env.var("GOOGLE_APPLICATION_CREDENTIALS").map(|v| v.trim().to_owned());
        let explicit = explicit.filter(|v| !v.is_empty());
        let path = match &explicit {
            Some(path) => PathBuf::from(path),
            None => self.gcloud_dir().join("application_default_credentials.json"),
        };
        let shown = path.display().to_string();
        let read = self.env.io.read_job(move |_| read_credential_text(&path)).await;
        match read {
            Ok(raw) => Ok(AdcRead::Found { raw, path: shown }),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => {
                if explicit.is_none() {
                    Ok(AdcRead::NoLogin)
                } else {
                    Err(format!("GOOGLE_APPLICATION_CREDENTIALS points to {shown}, which does not exist."))
                }
            }
            Err(e) => {
                let code = match e.kind() {
                    std::io::ErrorKind::PermissionDenied => "EACCES",
                    std::io::ErrorKind::IsADirectory => "EISDIR",
                    _ => "read failed",
                };
                Err(format!("Vertex AI could not read {shown}: {code}."))
            }
        }
    }

    /// `describeVertexAdc({ projectId })` as the settings show the gcloud login: its type, account
    /// and project, or why it cannot be used (`state` is `missing`, `invalid` or `unsupported`).
    /// Never carries a token or key. Without a login file, the metadata server's default service
    /// account: `probe_metadata` asks the server once (`probeVertexMetadata`, the outcome is kept),
    /// otherwise only an earlier probe's finding counts.
    pub async fn adc_describe(&self, project_override: &str, probe_metadata: bool) -> Value {
        let over = project_override.trim().to_owned();
        let env = self.env.env.clone();
        let get = |name: &str| env.var(name);
        match self.adc_text().await {
            Ok(AdcRead::Found { raw, path }) => match vertex::parse_adc(&raw, &path) {
                Ok(credential) => {
                    let project = if over.is_empty() {
                        match vertex::resolve_project(&credential, &get) {
                            Some(project) => Some(project),
                            None => self.gcloud_config_project().await,
                        }
                    } else {
                        Some(over)
                    };
                    json!({
                        "state": "ready",
                        "type": credential_type(&credential),
                        "account": Some(credential.account.clone()).filter(|a| !a.is_empty()),
                        "projectId": project.filter(|p| !p.is_empty()),
                    })
                }
                Err(error) => match unsupported_type(&error.message) {
                    Some(kind) => json!({ "state": "unsupported", "type": kind, "message": error.message }),
                    None => json!({ "state": "invalid", "message": error.message }),
                },
            },
            Ok(AdcRead::NoLogin) => {
                let served = if probe_metadata {
                    self.metadata_project.get_or_init(|| async { vertex_metadata::probe_project(&self.env.http).await }).await.clone()
                } else {
                    self.metadata_project.get().cloned().flatten()
                };
                match served {
                    Some(served) => {
                        // `vertexAdcProject(metadata)`: the environment, then the server's own project.
                        let project = if over.is_empty() {
                            vertex::PROJECT_ENV.iter().find_map(|name| get(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())).unwrap_or(served)
                        } else {
                            over
                        };
                        json!({ "state": "ready", "type": "metadata", "account": Value::Null, "projectId": project })
                    }
                    None => json!({ "state": "missing", "message": format!("No gcloud login found. {ADC_LOGIN_HINT}") }),
                }
            }
            Err(message) => json!({ "state": "invalid", "message": message }),
        }
    }

    /// The check a gcloud-login save makes: the login must already be usable (the metadata server
    /// is probed when there is no login file). `Ok(project)` is the project it names, `Err` the
    /// message of why it is not usable.
    pub async fn adc_login(&self, project_override: &str) -> Result<Option<String>, String> {
        let described = self.adc_describe(project_override, true).await;
        if described["state"] != "ready" {
            return Err(described["message"].as_str().unwrap_or_default().to_owned());
        }
        Ok(described["projectId"].as_str().map(str::to_owned))
    }
    async fn build_vertex(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        let http = self.env.http.clone();
        let traits = self.env.google_traits.clone();
        let mode = text(cfg, "authMode");
        if mode == Some("api-key") {
            let key = self.env.keys.resolve(name, &key_config(cfg)).await.map_err(|e| unread_key(name, &e))?;
            if key.trim().is_empty() {
                return Err("[vertex-ai] the Vertex AI API key is not configured".into());
            }
            return Ok(adapter(google::vertex_express(key.trim(), http, traits)));
        }
        let credential = if mode == Some("adc") {
            match self.adc_text().await? {
                AdcRead::Found { raw, path } => vertex::parse_adc(&raw, &path).map_err(|e| e.message)?,
                AdcRead::NoLogin => return self.build_vertex_metadata(cfg).await,
            }
        } else {
            let raw = self.env.keys.resolve(name, &key_config(cfg)).await.map_err(|e| unread_key(name, &e))?;
            vertex::parse_service_account(&raw).map_err(|e| e.message)?
        };
        let env = self.env.env.clone();
        let project = match text(cfg, "projectId") {
            Some(p) if p.len() <= 128 && p.chars().all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c)) => p.to_owned(),
            Some(_) => return Err("[vertex-ai] project ID override is invalid".into()),
            // A service-account key names its own project; the gcloud login
            // takes the environment, the file's quota project, then gcloud's
            // configured project.
            None if mode != Some("adc") => vertex::resolve_project(&credential, &|n| env.var(n))
                .ok_or_else(|| "[vertex-ai] no Google Cloud project is configured".to_owned())?,
            None => match vertex::resolve_project(&credential, &|n| env.var(n)) {
                Some(p) => p,
                None => self.gcloud_config_project().await.ok_or_else(|| {
                    "Vertex AI could not find a Google Cloud project for the gcloud login. Enter a project ID in Settings, \
                     set GOOGLE_CLOUD_PROJECT, or run `gcloud config set project PROJECT_ID`."
                        .to_owned()
                })?,
            },
        };
        let environment = env_location(|n| self.env.env.var(n), "");
        let place = VertexPlace::project(project, text(cfg, "location"), environment.as_deref());
        let auth = vertex::VertexAuth::new(http.clone(), credential, Box::new(now_ms_u64));
        let identity = auth.identity().to_owned();
        let auth: Arc<dyn RequestAuth> = Arc::new(auth);
        Ok(adapter(google::vertex(place, auth, identity, http, traits, self.env.anthropic_caps.clone())))
    }

    /// No gcloud login: the metadata server's default service account, when a
    /// probe finds one. The project is the settings override, the project
    /// variables, then the one the server names.
    async fn build_vertex_metadata(&self, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        let http = self.env.http.clone();
        let found = self
            .metadata_project
            .get_or_init(|| async { vertex_metadata::probe_project(&self.env.http).await })
            .await
            .clone();
        let Some(served) = found else {
            return Err(format!("No gcloud login found. {ADC_LOGIN_HINT}"));
        };
        let env = self.env.env.clone();
        let project = match text(cfg, "projectId") {
            Some(p) if p.len() <= 128 && p.chars().all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c)) => p.to_owned(),
            Some(_) => return Err("[vertex-ai] project ID override is invalid".into()),
            None => vertex::PROJECT_ENV
                .iter()
                .find_map(|name| env.var(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()))
                .unwrap_or(served.clone()),
        };
        let environment = env_location(|n| self.env.env.var(n), "");
        let place = VertexPlace::project(project, text(cfg, "location"), environment.as_deref());
        let auth = vertex_metadata::MetadataAuth::new(http.clone(), &served, Box::new(now_ms_u64));
        let identity = auth.identity().to_owned();
        let auth: Arc<dyn RequestAuth> = Arc::new(auth);
        Ok(adapter(google::vertex(place, auth, identity, http, self.env.google_traits.clone(), self.env.anthropic_caps.clone())))
    }

    async fn build_antigravity(&self, name: &str) -> Result<Arc<dyn ProviderAdapter>, String> {
        let store = Arc::new(FileTokenStore(self.file(name)?));
        let built = google::antigravity(
            store,
            self.env.antigravity_client_version.clone(),
            self.env.http.clone(),
            self.env.google_traits.clone(),
            Box::new(now_ms_u64),
        )
        .await
        .map_err(|e| e.message)?;
        Ok(adapter(built))
    }

    fn build_custom(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        self.build_custom_parts(name, cfg).map(|parts| {
            self.declare(name, parts.listing.clone());
            parts.adapter
        })
    }

    /// A custom provider with its model listing at hand: the setup probes read the listing's
    /// own discovery error (`customDiscoveryError`), which the adapter's `models()` hides.
    pub fn build_custom_parts(&self, name: &str, cfg: &Value) -> Result<CustomParts, String> {
        let protocol: Protocol = serde_json::from_value(cfg.get("protocol").cloned().unwrap_or(Value::Null))
            .map_err(|_| "[custom-provider] protocol must be openai-chat, openai-responses or anthropic".to_owned())?;
        let base_url = text(cfg, "baseURL").ok_or("[custom-provider] baseURL is required")?.trim_end_matches('/').to_owned();
        let protocol_wire = match protocol {
            Protocol::OpenaiChat => Wire::Chat,
            Protocol::OpenaiResponses => Wire::Responses,
            Protocol::Anthropic => Wire::Messages,
        };
        let served = custom_wires(cfg, &protocol, protocol_wire)?;
        let model_wires = custom_model_wires(cfg, &protocol, &served)?;
        let object = |key: &str| cfg.get(key).and_then(Value::as_object).cloned().unwrap_or_default();
        let headers = custom::normalize_headers(&object("headers"), "headers", &[]).map_err(|e| e.message)?;
        let request_body = custom::normalize_request_body(&object("requestBody"), "requestBody").map_err(|e| e.message)?;
        let mut model_body = Map::new();
        let mut model_headers = Vec::new();
        for (model, over) in object("modelOverrides") {
            if let Some(body) = over.get("requestBody").and_then(Value::as_object).filter(|b| !b.is_empty()) {
                let label = format!("modelOverrides[{model}].requestBody");
                model_body.insert(model.clone(), Value::Object(custom::normalize_request_body(body, &label).map_err(|e| e.message)?));
            }
            if let Some(h) = over.get("headers").and_then(Value::as_object).filter(|h| !h.is_empty()) {
                let label = format!("modelOverrides[{model}].headers");
                model_headers.push((model.clone(), custom::normalize_model_headers(h, &label).map_err(|e| e.message)?));
            }
        }
        // `auth: none` is authoritative: no key is read and no credential sent.
        // Otherwise the key is re-read per request (env mode: the named
        // variable alone), and a 401 reloads it.
        let keyless = text(cfg, "auth") == Some("none");
        let key = |header: &'static str, bearer: bool| -> Arc<dyn Credential> {
            Arc::new(CustomKey {
                source: (!keyless).then(|| self.key_source(name, cfg)),
                env: text(cfg, "apiKeyEnv").map(str::to_owned),
                header,
                bearer,
            })
        };
        let retry = CompatProfile::plain("custom", "http://127.0.0.1/v1", crate::providers::compat::profile::CredentialKind::Keyless)
            .retry_policy();
        let request = CustomRequestConfig { base_url: base_url.clone(), headers, request_body, model_body, model_headers };
        let mut engines: Vec<(Wire, Arc<dyn ProviderAdapter>)> = Vec::new();
        if !served.contains(&protocol_wire) {
            return Err("[custom-provider] the protocol wire is not served".into());
        }
        let header = if protocol_wire == Wire::Messages { key("x-api-key", false) } else { key("authorization", true) };
        let handle = Arc::new(CustomListing::new(
            name,
            protocol.clone(),
            &base_url,
            request.headers.clone(),
            self.env.http.clone(),
            header,
            keyless,
            cfg,
            self.env.listing.clone(),
        ));
        // The Chat wire replays a model's reasoning as its own row says (`getCachedModelInfo`), at the turn's
        // effort, else the provider's `reasoningEffort`.
        let replay = {
            let rows = handle.clone();
            let configured = text(cfg, "reasoningEffort").map(str::to_owned);
            let base = base_url.clone();
            crate::providers::compat::chat::CustomReplay(Arc::new(move |request: &mixdog_core_api::domain::provider::ModelRequest| {
                let row = crate::catalog::CachedModelInfo::cached_row(&*rows, &request.model);
                let effort = request.options.effort.as_deref().or(configured.as_deref());
                custom::chat_replays(row.as_deref(), effort, &base)
            }))
        };
        for wire in &served {
            // The provider lists its models once, through the engine of its protocol's wire.
            let listing = (*wire == protocol_wire).then(|| -> Arc<dyn ModelListing> { handle.clone() });
            let engine: Arc<dyn ProviderAdapter> = match wire {
                Wire::Messages => {
                    // Node's custom class on the anthropic protocol is an `AnthropicProvider` subclass.
                    let engine = self.custom_messages_engine(name, &request, key("x-api-key", false)).with_input_excludes_cache(protocol == Protocol::Anthropic);
                    Arc::new(match listing {
                        Some(listing) => engine.with_listing(listing),
                        None => engine,
                    })
                }
                other => {
                    let family = if *other == Wire::Chat {
                        custom::chat_codec(name, &base_url, replay.clone())
                    } else {
                        custom::responses_codec(name, &base_url)
                    };
                    let engine = HttpAdapter::new(
                        ProviderId::from(name),
                        Arc::new(RewriteCodec::new(family, CustomRewriter { config: request.clone() })),
                        Arc::new(GatewayHttp::new(self.env.http.clone()).through_sdk(Sdk::OpenAi, &request.headers)),
                        key("authorization", true),
                        retry.clone(),
                    );
                    Arc::new(match listing {
                        Some(listing) => engine.with_listing(listing),
                        None => engine,
                    })
                }
            };
            engines.push((*wire, engine));
        }
        let listing = handle;
        // `createCustomProvider` registers a wire profile for every OpenAI-compatible protocol, one wire or
        // several, so such a provider always routes (and pins) its wire; only the anthropic protocol has none.
        if engines.len() == 1 && protocol == Protocol::Anthropic {
            return Ok(CustomParts { adapter: engines.remove(0).1, listing });
        }
        let adapter = Arc::new(MultiWireAdapter::new(ProviderId::from(name), engines, protocol_wire, model_wires));
        Ok(CustomParts { adapter, listing })
    }

    /// The Messages engine of a custom provider (the `anthropic` protocol, or
    /// an OpenAI-compatible endpoint that declares the `messages` wire): the
    /// Anthropic codec under the custom id, with the provider's headers and
    /// request fields layered on. The Anthropic SDK appends `/v1/messages`
    /// itself, so an endpoint's `/v1` base maps to it.
    fn custom_messages_engine(&self, name: &str, request: &CustomRequestConfig, credential: Arc<dyn Credential>) -> HttpAdapter {
        let mut config = AnthropicConfig::new(self.env.anthropic_caps.clone());
        let base = request.base_url.as_str();
        config.base_url = match base.len().checked_sub(3).filter(|at| base.is_char_boundary(*at)) {
            Some(at) if base[at..].eq_ignore_ascii_case("/v1") => base[..at].to_owned(),
            _ => base.to_owned(),
        };
        config.custom_endpoint = true;
        // The Anthropic SDK's own `accept`.
        config.extra_headers = vec![("accept".to_owned(), "application/json".to_owned())];
        // The Anthropic engine's retry rows, read off an adapter built the same way.
        let policy = AnthropicAdapter::api_key(
            config.clone(),
            self.env.http.clone(),
            Arc::new(FixedKey(String::new())),
            self.env.gzip_lane,
        )
        .retry_policy()
        .clone();
        let codec = AnthropicCodec::new(Flavor::ApiKey, config);
        HttpAdapter::new(
            ProviderId::from(name),
            Arc::new(RewriteCodec::new(Arc::new(codec), CustomRewriter { config: request.clone() })),
            Arc::new(GatewayHttp::new(self.env.http.clone()).through_sdk(Sdk::Anthropic, &request.headers)),
            credential,
            policy,
        )
    }

    async fn build_cursor(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        let http = self.env.http.clone();
        let tokens: Arc<dyn crate::providers::cursor::AccessToken> = if name == "cursor-api" {
            let key = self.env.keys.resolve(name, &key_config(cfg)).await.map_err(|e| unread_key(name, &e))?;
            Arc::new(ApiKeyAccess::new(http.clone(), key))
        } else {
            Arc::new(FileAccess::new(http.clone(), self.file(name)?))
        };
        let built = Arc::new(CursorAdapter::new(
            name,
            None,
            self.env.cursor_client_version.clone(),
            http,
            self.env.bidi.clone(),
            tokens,
        ));
        self.declare(name, built.clone());
        Ok(built)
    }
}

impl DefaultProviderBuilder {
    async fn build_unversioned(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        if name.starts_with("custom-") && text(cfg, "type") == Some("custom") {
            return self.build_custom_pool(name, cfg).await;
        }
        match name {
            "anthropic" | "anthropic-oauth" => self.build_anthropic(name, cfg).await,
            "openai" | "openai-oauth" => self.build_openai(name, cfg),
            "gemini" => self.build_gemini(name, cfg).await,
            "vertex-ai" => self.build_vertex(name, cfg).await,
            "antigravity-oauth" => self.build_antigravity(name).await,
            "xai" | "deepseek" | "openrouter" | "mimo-oauth" | "command-code-oauth" | "muse-code-oauth"
            | "opencode-go-oauth" => self.build_compat(name, cfg).await,
            "grok-oauth" => {
                let credential = Arc::new(GrokCredential::new(self.env.http.clone(), self.file(name)?).with_pace(self.env.pace.clone()));
                let retry = CompatProfile::xai().retry_policy();
                Ok(adapter(grok::adapter(
                    self.env.http.clone(),
                    credential,
                    self.env.grok_client_version.clone(),
                    retry,
                    self.env.listing.clone(),
                    self.env.client_versions.clone(),
                )))
            }
            "cursor-oauth" | "cursor-api" => self.build_cursor(name, cfg).await,
            "devin-oauth" => {
                let built = Arc::new(DevinAdapter::new(
                    text(cfg, "baseUrl").map(str::to_owned),
                    self.env.http.clone(),
                    Arc::new(FileSessionToken(self.file(name)?)),
                ));
                self.declare(name, built.clone());
                Ok(built)
            }
            // `registry.mjs`: `MixdogLocalProvider`, constructed with no endpoint; the server starts on a send.
            "mixdog-local" => match &self.env.local {
                Some(runtime) => {
                    // The installed models are read once now, so `getCachedModelInfo` has its answer from the moment the
                    // provider exists (Node reads the disk on every call); a failed read leaves it a miss until the next.
                    let _ = runtime.installed().await;
                    let built = Arc::new(crate::providers::local::RegisteredAdapter::new(self.env.http.clone(), runtime.clone()));
                    self.declare(name, built.clone());
                    Ok(built)
                }
                None => Err("mixdog-local needs the managed local runtime, which this host does not have".into()),
            },
            other => Err(format!("unknown enabled provider: {other}")),
        }
    }
}

#[async_trait]
impl ProviderBuilder for DefaultProviderBuilder {
    /// The adapter, and for a dialect that gates on a client version, a wrapper that warms the
    /// version before each send and learns a Grok minimum from a 426.
    async fn build(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        self.capabilities.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(name);
        let built = self.build_unversioned(name, cfg).await?;
        Ok(match (self.env.client_versions.as_ref(), Dialect::of_provider(name)) {
            (Some(versions), Some(dialect)) => VersionedAdapter::wrap(built, dialect, Arc::clone(versions)),
            _ => built,
        })
    }

    /// The capability the adapter built under `name` owns, when its Node class has `getCachedModelInfo` (own or
    /// inherited; verified at `b6f10295a` under `src/runtime/agent/orchestrator/providers/`): `custom-*`
    /// (`custom-provider.mjs:109`), the compat family whose profile says so (`openai-compat.mjs:280`; `WireGatewayProvider`,
    /// `wire-gateway.mjs:166`, for deepseek and openrouter), `cursor-oauth` / `cursor-api` (`cursor.mjs:601`),
    /// `devin-oauth` (`devin.mjs:316`), `mixdog-local` (`mixdog-local.mjs:91`: the installed model's row, which the managed
    /// runtime keeps current for a synchronous read, `LocalRuntime::installed_now`). `anthropic`, `anthropic-oauth`, `openai`, `gemini`, `vertex-ai`,
    /// `antigravity-oauth`, `grok-oauth`, `mimo-oauth` and `command-code-oauth` define none.
    fn cached_model_info(&self, name: &str) -> Option<Arc<dyn CachedModelInfo>> {
        self.capabilities.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(name).cloned()
    }

    async fn custom_key_ids(&self, name: &str) -> Result<Vec<String>, String> {
        match self.env.accounts.custom_key_ids(name).await {
            Ok(ids) => Ok(ids),
            Err(error) if error.unrun() => Err(format!("The additional API keys of {name} could not be read: {error}.")),
            Err(_) => Ok(Vec::new()),
        }
    }

    fn available(&self, name: &str) -> bool {
        !(self.env.gated_off)(name)
    }

    async fn oauth_credentials_usable(&self, name: &str) -> Result<bool, String> {
        // An unreadable file counts as present: it is never a logout, so a credential read that
        // never ran (`Probe::Unreadable`) already reads as present here and cannot be missing.
        Ok(OAUTH_PROVIDER_NAMES.contains(&name) && self.env.accounts.has_credential(name, "default").await.unwrap_or(false))
    }

    async fn oauth_credential_state(&self, name: &str) -> Result<CredentialState, String> {
        // oauthCredentialProbeState: a dev-gated provider whose option is off always reads absent.
        if !OAUTH_PROVIDER_NAMES.contains(&name) || !self.available(name) {
            return Ok(CredentialState::Absent);
        }
        // A read that never ran is a momentary failure (Node's catch), not a logout.
        Ok(self.env.accounts.credential_state(name, "default").await.unwrap_or(CredentialState::Unreadable))
    }
}

#[cfg(test)]
mod tests;

/// Names the default builder can construct (the rest are unknown providers).
pub fn buildable_names() -> HashSet<&'static str> {
    [
        "anthropic",
        "anthropic-oauth",
        "openai",
        "openai-oauth",
        "gemini",
        "vertex-ai",
        "antigravity-oauth",
        "xai",
        "deepseek",
        "openrouter",
        "mimo-oauth",
        "command-code-oauth",
        "muse-code-oauth",
        "opencode-go-oauth",
        "grok-oauth",
        "cursor-oauth",
        "cursor-api",
        "devin-oauth",
    ]
    .into_iter()
    .collect()
}
