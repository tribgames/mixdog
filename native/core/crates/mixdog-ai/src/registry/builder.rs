//! The adapter each provider id stands for (`instantiateProvider` and the
//! provider modules of `providers/registry.mjs`), built from the provider's
//! config entry, its credentials and the host's seams.
//!
//! Admission and account rotation wrap sends above the adapter, so each
//! built adapter is the plain one. `mixdog-local` is not built here: its
//! adapter is made per turn from the endpoint the managed runtime reports
//! (`providers::local::adapter`).

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

use super::keys::ApiKeyStore;
use super::keys::KeyConfig;
use super::keys::ProviderKey;
use super::providers::OAUTH_PROVIDER_NAMES;
use super::providers::ProviderBuilder;
use crate::accounts::AccountStore;
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
use crate::providers::compat::chat::CompatChatCodec;
use crate::providers::compat::chat::CompatConfig;
use crate::providers::compat::creds::MimoCredentials;
use crate::providers::compat::creds::OpenCodeGoCredentials;
use crate::oauth::CredentialIo;
use crate::providers::compat::profile::CompatProfile;
use crate::providers::cursor::CursorAdapter;
use crate::providers::cursor::auth::ApiKeyAccess;
use crate::providers::cursor::auth::FileAccess;
use super::multiwire::MultiWireAdapter;
use super::vertex_metadata;
use crate::providers::anthropic::AnthropicCodec;
use crate::providers::anthropic::Flavor;
use crate::providers::compat::profile::Wire;
use crate::providers::connect::rewrite::HttpAdapter;
use crate::providers::connect::rewrite::RewriteCodec;
use crate::providers::connect::rewrite::Credential;
use crate::providers::custom;
use crate::providers::custom::CustomRequestConfig;
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
use crate::providers::openai::codec::OpenAiCodec;
use crate::providers::openai::config::CodexIdentity;
use crate::providers::openai::config::ModelFactsSource;
use crate::providers::openai::config::OpenAiConfig;
use crate::providers::openai::config::WireContext;
use crate::providers::openai::oauth::OpenAiOAuth;
use crate::transport::BidiOpen;
use crate::transport::HttpSend;
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
    pub grok_client_version: Option<String>,
    pub cursor_client_version: Option<String>,
    pub antigravity_client_version: String,
    /// Process environment (`GOOGLE_APPLICATION_CREDENTIALS`, project and
    /// location variables, custom `apiKeyEnv`).
    pub env: Arc<dyn super::keys::Environment>,
    /// The user's home directory and `%APPDATA%`-style base for gcloud's ADC.
    pub home_dir: PathBuf,
    /// The lane the gcloud configuration and ADC files are read on.
    pub io: CredentialIo,
    /// `providerAvailable`: names a Developer option currently gates off.
    pub gated_off: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

pub struct DefaultProviderBuilder {
    env: BuilderEnv,
    /// The metadata server's project, probed once per process (a negative
    /// outcome is kept too).
    metadata_project: tokio::sync::OnceCell<Option<String>>,
}

impl DefaultProviderBuilder {
    pub fn new(env: BuilderEnv) -> Self {
        Self { env, metadata_project: tokio::sync::OnceCell::new() }
    }
}

// The two readers below are bodies of lane jobs (`CredentialIo::read_job`).
#[allow(clippy::disallowed_methods, reason = "body of a lane job")]
fn read_text(path: &std::path::Path) -> std::io::Result<String> {
    std::fs::read_to_string(path)
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

fn text<'a>(cfg: &'a Value, key: &str) -> Option<&'a str> {
    cfg.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn flag(cfg: &Value, key: &str) -> Option<bool> {
    cfg.get(key).and_then(Value::as_bool)
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
            Err(RefreshError::Reauth(message)) => Err(reauth(&format!("OpenCode sign-in expired: {message}"))),
            Err(RefreshError::Failed(message)) => {
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

    fn key_source(&self, provider: &str, cfg: &Value) -> Arc<ProviderKey> {
        ProviderKey::primary(self.env.keys.clone(), provider, key_config(cfg))
    }

    async fn build_anthropic(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        let mut config = AnthropicConfig::new(self.env.anthropic_caps.clone());
        if let Some(url) = text(cfg, "baseURL") {
            config.base_url = url.trim_end_matches('/').to_owned();
        }
        config.disable_beta_headers = flag(cfg, "disableBetaHeaders").unwrap_or(false);
        let http = self.env.http.clone();
        if name == "anthropic" {
            let keys = self.key_source(name, cfg);
            return Ok(adapter(AnthropicAdapter::api_key(config, http, keys, self.env.gzip_lane)));
        }
        let session = Arc::new(OAuthSession::new(self.file(name)?, http.clone()));
        let enterprise = session.stored().await.map(|s| s.is_enterprise()).unwrap_or(false);
        Ok(adapter(AnthropicAdapter::oauth(config, http, session, enterprise, self.env.gzip_lane)))
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
                credentials,
                context: self.env.openai_context.clone(),
            },
        )))
    }

    fn compat_codec(
        &self,
        profile: CompatProfile,
        cfg: &Value,
        base_url: Option<String>,
        login_headers: Vec<(String, String)>,
    ) -> CompatChatCodec {
        let mut extra_headers = string_pairs(cfg, "extraHeaders");
        extra_headers.extend(login_headers);
        let config = CompatConfig {
            base_url: base_url.or_else(|| text(cfg, "baseURL").map(|u| u.trim_end_matches('/').to_owned())),
            client_version: self.env.client_version.clone(),
            extra_headers,
            ..CompatConfig::for_profile(&profile)
        };
        CompatChatCodec::new(profile, config)
    }

    async fn build_compat(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        let http = self.env.http.clone();
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
        let codec = self.compat_codec(profile, cfg, base_url, login_headers);
        Ok(adapter(CompatAdapter::new(codec, http, Some(key))))
    }

    async fn build_gemini(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        let key = self.env.keys.resolve(name, &key_config(cfg)).await;
        Ok(adapter(google::gemini(key, self.env.http.clone(), self.env.google_traits.clone())))
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
            .read_job(move || Ok(read_gcloud_project(&dir, named)))
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
        let read = self.env.io.read_job(move || read_text(&path)).await;
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

    async fn build_vertex(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        let http = self.env.http.clone();
        let traits = self.env.google_traits.clone();
        let mode = text(cfg, "authMode");
        if mode == Some("api-key") {
            let key = self.env.keys.resolve(name, &key_config(cfg)).await;
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
            let raw = self.env.keys.resolve(name, &key_config(cfg)).await;
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
        Ok(adapter(google::vertex(place, auth, identity, http, traits)))
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
        Ok(adapter(google::vertex(place, auth, identity, http, self.env.google_traits.clone())))
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
        for wire in &served {
            let engine: Arc<dyn ProviderAdapter> = match wire {
                Wire::Messages => Arc::new(self.custom_messages_engine(name, &request, key("x-api-key", false))),
                other => {
                    let family = if *other == Wire::Chat {
                        custom::chat_codec(name, &base_url)
                    } else {
                        custom::responses_codec(name, &base_url)
                    };
                    Arc::new(HttpAdapter::new(
                        ProviderId::from(name),
                        Arc::new(RewriteCodec::new(family, CustomRewriter { config: request.clone() })),
                        self.env.http.clone(),
                        key("authorization", true),
                        retry.clone(),
                    ))
                }
            };
            engines.push((*wire, engine));
        }
        if engines.len() == 1 {
            return Ok(engines.remove(0).1);
        }
        Ok(Arc::new(MultiWireAdapter::new(ProviderId::from(name), engines, protocol_wire, model_wires)))
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
            self.env.http.clone(),
            credential,
            policy,
        )
    }

    async fn build_cursor(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        let http = self.env.http.clone();
        let tokens: Arc<dyn crate::providers::cursor::AccessToken> = if name == "cursor-api" {
            let key = self.env.keys.resolve(name, &key_config(cfg)).await;
            Arc::new(ApiKeyAccess::new(http.clone(), key))
        } else {
            Arc::new(FileAccess::new(http.clone(), self.file(name)?))
        };
        Ok(adapter(CursorAdapter::new(
            name,
            None,
            self.env.cursor_client_version.clone(),
            http,
            self.env.bidi.clone(),
            tokens,
        )))
    }
}

#[async_trait]
impl ProviderBuilder for DefaultProviderBuilder {
    async fn build(&self, name: &str, cfg: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        if name.starts_with("custom-") && text(cfg, "type") == Some("custom") {
            return self.build_custom(name, cfg);
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
                let credential = Arc::new(GrokCredential::new(self.env.http.clone(), self.file(name)?));
                let retry = CompatProfile::xai().retry_policy();
                Ok(adapter(grok::adapter(self.env.http.clone(), credential, self.env.grok_client_version.clone(), retry)))
            }
            "cursor-oauth" | "cursor-api" => self.build_cursor(name, cfg).await,
            "devin-oauth" => Ok(adapter(DevinAdapter::new(
                text(cfg, "baseUrl").map(str::to_owned),
                self.env.http.clone(),
                Arc::new(FileSessionToken(self.file(name)?)),
            ))),
            "mixdog-local" => Err("mixdog-local is built per turn from the managed runtime's endpoint".into()),
            other => Err(format!("unknown enabled provider: {other}")),
        }
    }

    async fn custom_key_ids(&self, name: &str) -> Vec<String> {
        self.env.accounts.custom_key_ids(name).await.unwrap_or_default()
    }

    fn available(&self, name: &str) -> bool {
        !(self.env.gated_off)(name)
    }

    async fn oauth_credentials_usable(&self, name: &str) -> bool {
        // An unreadable file counts as present: it is never a logout.
        OAUTH_PROVIDER_NAMES.contains(&name) && self.env.accounts.has_credential(name, "default").await.unwrap_or(false)
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
