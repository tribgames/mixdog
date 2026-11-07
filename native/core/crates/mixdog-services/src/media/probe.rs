//! The credential side of the media lanes (`lanes.mjs` `laneAuthenticated`, `auth.mjs`,
//! `oauth-credential-probes.mjs` for the three OAuth lanes, `catalog.mjs` `providerSource`):
//! whether a lane has usable credentials, the request credentials of a lane, and the catalog
//! source that keys its cache by credential. Reading the token documents is file work on the
//! durability lane; the keychain, the agent config, the developer options and the OAuth token
//! stores (which refresh) are seams the caller supplies.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_js::{js_trim, to_number};
use mixdog_rt::DurabilityIo;
use mixdog_statefile::read_content;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::accounts::AccountProbe;
use super::catalog::{CatalogFailure, image_api_lane};
use super::catalog_fetch::{Auth, CatalogHttp, FetchError, FileCatalogCache, fetch_media_model_rows};
use super::lanes::{CatalogRows, lane_auth};
use super::loader::{CatalogSource, ModelLoader, Target};
use crate::lane::on_lane;

/// `getAgentApiKey` / `hasAgentApiKey`: environment first, then the keychain.
#[async_trait]
pub trait AgentKeys: Send + Sync {
    async fn has(&self, provider: &str) -> bool;
    async fn get(&self, provider: &str) -> Option<String>;
}

/// The agent config and settings the lanes read.
pub trait AgentSettings: Send + Sync {
    /// `readSection('agent').providers`.
    fn providers(&self) -> Value;
    /// `developerOptionEnabled` of the option gating a dev-only OAuth provider.
    fn developer_enabled(&self, provider: &str) -> bool;
}

/// What the OAuth token stores and the provider layer answer for a lane: the refreshed bearer of
/// a signed-in account, and the Codex / Antigravity model lists.
#[async_trait]
pub trait ProviderAuth: Send + Sync {
    /// `resolveXaiAuth('grok-oauth')` / `resolveAntigravityAuth()`: the token (and the account or
    /// project that identifies it) of the account whose credential file is `account`.
    async fn oauth(&self, lane: &str, account: Option<&Path>) -> Result<Auth, FetchError>;
    /// The rows of a catalog the provider layer fetches itself (`openai-oauth`, `antigravity-oauth`).
    async fn provider_rows(&self, lane: &str, auth: &Auth) -> Result<Value, FetchError>;
}

pub struct ProbeParts {
    pub data_dir: PathBuf,
    pub lane: DurabilityIo,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// `process.env`.
    pub env: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    pub keys: Arc<dyn AgentKeys>,
    pub settings: Arc<dyn AgentSettings>,
    pub provider_auth: Arc<dyn ProviderAuth>,
    pub http: Arc<dyn CatalogHttp>,
    /// `providerCatalogRevision()`.
    pub revision: Arc<dyn Fn() -> String + Send + Sync>,
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `normalizeExpiresAtMs`: unix seconds or milliseconds, a numeric string or an ISO-8601 string;
/// 0 when unknown.
fn normalize_expires_at_ms(value: Option<&Value>) -> f64 {
    let Some(value) = value.filter(|v| !v.is_null()) else { return 0.0 };
    if let Value::String(text) = value {
        if mixdog_js::string_to_number(js_trim(text)).is_nan() && !js_trim(text).is_empty() {
            return chrono::DateTime::parse_from_rfc3339(js_trim(text)).map_or(0.0, |at| at.timestamp_millis() as f64);
        }
    }
    let number = if truthy(Some(value)) { to_number(value) } else { 0.0 };
    if !number.is_finite() || number <= 0.0 {
        return 0.0;
    }
    if number < 1e12 { number * 1000.0 } else { number }
}

/// `expiryFromAccessToken`: the `exp` claim of a JWT, in ms; 0 for anything else.
fn expiry_from_access_token(token: &str) -> f64 {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return 0.0;
    }
    let bytes = super::upstream::node_base64(parts[1]);
    let Ok(payload) = serde_json::from_slice::<Value>(&bytes) else { return 0.0 };
    let exp = to_number(payload.get("exp").unwrap_or(&Value::Null));
    if exp.is_finite() && exp > 0.0 { exp * 1000.0 } else { 0.0 }
}

/// `signedInTokenDocumentUntil`: until when the document is a sign-in; infinity with a refresh
/// token, else its access token's expiry; 0 when it never is.
fn signed_in_until(doc: &Value) -> f64 {
    if !truthy(doc.get("access_token")) {
        return 0.0;
    }
    if truthy(doc.get("refresh_token")) {
        return f64::INFINITY;
    }
    let stated = normalize_expires_at_ms(doc.get("expires_at").filter(|v| !v.is_null()).or_else(|| doc.get("expiresAt")));
    if stated != 0.0 { stated } else { expiry_from_access_token(&mixdog_js::value_to_string(&doc["access_token"])) }
}

/// `nanoGptHost`.
fn nano_gpt_host(base_url: &str) -> bool {
    reqwest::Url::parse(base_url).ok().and_then(|url| url.host_str().map(str::to_lowercase)).is_some_and(|host| host == "nano-gpt.com" || host.ends_with(".nano-gpt.com"))
}

pub struct FileAccountProbe {
    parts: ProbeParts,
    loaders: Mutex<HashMap<Option<PathBuf>, Arc<ModelLoader>>>,
}

impl FileAccountProbe {
    pub fn new(parts: ProbeParts) -> Self {
        Self { parts, loaders: Mutex::default() }
    }

    fn env(&self, name: &str) -> Option<String> {
        (self.parts.env)(name)
    }

    /// `MIXDOG_MODEL_PROXY=client`: this server holds no model credentials.
    fn remote_client(&self) -> bool {
        self.env("MIXDOG_MODEL_PROXY").as_deref() == Some("client")
    }

    /// `hasAgentApiKey`.
    async fn has_agent_key(&self, provider: &str) -> bool {
        !self.remote_client() && !js_trim(provider).is_empty() && self.parts.keys.has(js_trim(provider)).await
    }

    /// `getAgentApiKey`.
    async fn agent_key(&self, provider: &str) -> Option<String> {
        if self.remote_client() { None } else { self.parts.keys.get(js_trim(provider)).await }
    }

    /// `nanoGptProviders()`: enabled, keyed custom endpoints on a NanoGPT host.
    fn nano_gpt_providers(&self) -> Vec<(String, Value)> {
        let providers = self.parts.settings.providers();
        let Some(map) = providers.as_object() else { return Vec::new() };
        map.iter()
            .filter(|(id, entry)| {
                id.starts_with("custom-")
                    && entry.get("type").and_then(Value::as_str) == Some("custom")
                    && entry.get("enabled") != Some(&Value::Bool(false))
                    && entry.get("auth").and_then(Value::as_str) != Some("none")
                    && nano_gpt_host(&mixdog_js::value_to_string(entry.get("baseURL").unwrap_or(&Value::Null)))
            })
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect()
    }

    /// `hasProviderApiKey(id, entry)`.
    async fn has_provider_key(&self, id: &str, entry: &Value) -> bool {
        if truthy(entry.get("apiKeyEnv")) {
            return truthy(self.env(&mixdog_js::value_to_string(&entry["apiKeyEnv"])).map(Value::String).as_ref());
        }
        truthy(entry.get("apiKey")) || self.has_agent_key(id).await
    }

    /// `resolveProviderApiKey(id, entry)`.
    async fn provider_key(&self, id: &str, entry: &Value) -> String {
        if truthy(entry.get("apiKeyEnv")) {
            return self.env(&mixdog_js::value_to_string(&entry["apiKeyEnv"])).unwrap_or_default();
        }
        if truthy(entry.get("apiKey")) {
            return mixdog_js::value_to_string(&entry["apiKey"]);
        }
        self.agent_key(id).await.unwrap_or_default()
    }

    /// `hasImageApiCredentials`.
    async fn has_image_api_credentials(&self, lane: &str) -> bool {
        match lane {
            "openrouter" => self.has_agent_key("openrouter").await,
            "nano-gpt" => {
                for (id, entry) in self.nano_gpt_providers() {
                    if self.has_provider_key(&id, &entry).await {
                        return true;
                    }
                }
                false
            }
            _ => false,
        }
    }

    /// `resolveImageApiAuth`: base URL and bearer, or the unauthenticated refusal.
    pub(super) async fn image_api_auth(&self, lane: &str) -> Result<Auth, FetchError> {
        let mut token = String::new();
        if lane == "openrouter" {
            token = self.agent_key("openrouter").await.unwrap_or_default();
        } else if lane == "nano-gpt" {
            for (id, entry) in self.nano_gpt_providers() {
                token = self.provider_key(&id, &entry).await;
                if !token.is_empty() {
                    break;
                }
            }
        }
        if token.is_empty() {
            return Err(unauthenticated(format!("{lane} API key is not configured")));
        }
        let base_url = if lane == "openrouter" { "https://openrouter.ai/api/v1" } else { "https://api.nano-gpt.com/api/v1" };
        Ok(Auth { token, base_url: base_url.to_owned(), ..Auth::default() })
    }

    /// `resolveXaiAuth('xai')` / `resolveGeminiKey()`.
    pub(super) async fn api_key_auth(&self, lane: &str) -> Result<Auth, FetchError> {
        let (provider, label, base_url) = if lane == "xai" { ("xai", "xAI", "https://api.x.ai/v1") } else { ("gemini", "Gemini", "") };
        match self.agent_key(provider).await {
            Some(key) if !key.is_empty() => Ok(Auth { token: key, base_url: base_url.to_owned(), ..Auth::default() }),
            _ => Err(unauthenticated(format!("{label} API key is not configured"))),
        }
    }

    /// The credential file of a lane's OAuth provider: the account's, else the provider's path
    /// variable, else the legacy file in the data folder.
    fn credential_file(&self, provider: &str, account: Option<&Path>) -> PathBuf {
        let (variable, legacy) = match provider {
            "openai-oauth" => ("OPENAI_OAUTH_CREDENTIALS_PATH", "openai-oauth.json"),
            "grok-oauth" => ("GROK_OAUTH_CREDENTIALS_PATH", "grok-oauth.json"),
            _ => ("ANTIGRAVITY_OAUTH_CREDENTIALS_PATH", "antigravity-oauth.json"),
        };
        account.map(Path::to_owned).or_else(|| self.env(variable).filter(|p| !p.is_empty()).map(PathBuf::from)).unwrap_or_else(|| self.parts.data_dir.join(legacy))
    }

    /// The three OAuth probes: `present` when the token document is usable right now.
    async fn oauth_present(&self, provider: &str, account: Option<&Path>) -> bool {
        if self.remote_client() || (provider == "antigravity-oauth" && !self.parts.settings.developer_enabled(provider)) {
            return false;
        }
        let path = self.credential_file(provider, account);
        let Some(doc) = on_lane(self.parts.lane, move || read_content(&path)).await.ok().and_then(Result::ok).flatten().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()) else {
            return false;
        };
        let now = (self.parts.now)() as f64;
        match provider {
            "openai-oauth" => signed_in_until(&doc) > now,
            "grok-oauth" => truthy(doc.get("access_token")) && truthy(doc.get("refresh_token")),
            _ => truthy(doc.get("access_token")) && truthy(doc.get("refresh_token")) && truthy(doc.get("project_id")),
        }
    }

    /// `providerSource(lane)` for one account.
    pub(super) fn source_for(self: &Arc<Self>, account: Option<&Path>) -> Arc<ProviderSource> {
        Arc::new(ProviderSource { probe: self.clone(), account: account.map(Path::to_owned), auth: Mutex::default() })
    }

    pub(super) fn loader_for(self: &Arc<Self>, account: Option<&Path>) -> Arc<ModelLoader> {
        let mut loaders = self.loaders.lock().unwrap();
        loaders
            .entry(account.map(Path::to_owned))
            .or_insert_with(|| {
                let cache = Arc::new(FileCatalogCache { data_dir: self.parts.data_dir.clone(), lane: self.parts.lane, now: self.parts.now.clone() });
                Arc::new(ModelLoader::new(self.source_for(account), cache, self.parts.now.clone()))
            })
            .clone()
    }
}

/// `unauthenticated(message)`: `MEDIA_LANE_UNAUTHENTICATED`, 401.
fn unauthenticated(message: String) -> FetchError {
    FetchError { message, code: Some("MEDIA_LANE_UNAUTHENTICATED".to_owned()), status: Some(401), timed_out: false }
}

/// `laneAuthenticated(lane)` and the catalog of a lane, for the accounts a run is bound to.
pub struct AccountedProbe(pub Arc<FileAccountProbe>);

#[async_trait]
impl AccountProbe for AccountedProbe {
    async fn authenticated(&self, lane_id: &str, account: Option<&Path>) -> bool {
        let probe = &self.0;
        let Some((auth_type, provider)) = lane_auth(lane_id) else { return false };
        if image_api_lane(lane_id) {
            return probe.has_image_api_credentials(lane_id).await;
        }
        if auth_type == "api-key" {
            return probe.has_agent_key(provider).await;
        }
        match provider {
            "grok-oauth" | "openai-oauth" | "antigravity-oauth" => probe.oauth_present(provider, account).await,
            _ => false,
        }
    }

    async fn models(&self, lane_id: &str, account: Option<&Path>) -> Result<CatalogRows, CatalogFailure> {
        self.0.loader_for(account).load(lane_id).await
    }
}

pub(super) struct ProviderSource {
    probe: Arc<FileAccountProbe>,
    account: Option<PathBuf>,
    /// The credentials `target` resolved, for the `fetch` that follows.
    auth: Mutex<HashMap<String, Auth>>,
}

impl ProviderSource {
    fn failure(error: &FetchError) -> CatalogFailure {
        error.failure()
    }
}

#[async_trait]
impl CatalogSource for ProviderSource {
    async fn target(&self, lane: &str) -> Result<Target, CatalogFailure> {
        let revision = (self.probe.parts.revision)();
        // The account catalog has its own 24 h cache: no second TTL in front of it.
        if lane == "openai-oauth" {
            return Ok(Target { key: lane.to_owned(), revision, cached: false });
        }
        let auth = if image_api_lane(lane) {
            self.probe.image_api_auth(lane).await
        } else if lane == "gemini" || lane == "xai" {
            self.probe.api_key_auth(lane).await
        } else {
            self.probe.parts.provider_auth.oauth(lane, self.account.as_deref()).await
        }
        .map_err(|error| Self::failure(&error))?;
        // A one-way scope hash, never a key or a bearer: a rotating bearer would be a permanent
        // cache miss, so the stable account identity (Cloud project or account id) plays that role.
        let identity = [auth.project_id.as_deref(), auth.account_id.as_deref(), Some(auth.token.as_str())].into_iter().flatten().find(|id| !id.is_empty()).unwrap_or_default();
        let scope: String = Sha256::digest(identity.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>().chars().take(24).collect();
        self.auth.lock().unwrap().insert(lane.to_owned(), auth);
        Ok(Target { key: format!("{lane}-{scope}"), revision, cached: true })
    }

    async fn fetch(&self, lane: &str) -> Result<Value, CatalogFailure> {
        let auth = self.auth.lock().unwrap().get(lane).cloned().unwrap_or_default();
        let result = if lane == "openai-oauth" || lane == "antigravity-oauth" {
            let rows = self.probe.parts.provider_auth.provider_rows(lane, &auth).await;
            // The account's Codex list: none at all is an outage, not an empty catalog.
            match rows {
                Ok(Value::Array(rows)) if lane == "openai-oauth" && rows.is_empty() => Err(FetchError { message: "Codex catalog unavailable".to_owned(), code: None, status: None, timed_out: false }),
                other => other,
            }
        } else {
            fetch_media_model_rows(self.probe.parts.http.as_ref(), lane, &auth).await
        };
        result.map_err(|error| Self::failure(&error))
    }
}
